// @flow

/** Query compiler extracts queries and fragments from all files, validates them
 * and then collocates them with fragments they require. This way fragments
 * have global scope and can be used in any other query or fragment.
 */

const _ = require(`lodash`)

const path = require(`path`)
const normalize = require(`normalize-path`)
const glob = require(`glob`)

const {
  validate,
  print,
  visit,
  visitWithTypeInfo,
  TypeInfo,
  isAbstractType,
  Kind,
  FragmentsOnCompositeTypesRule,
  LoneAnonymousOperationRule,
  PossibleFragmentSpreadsRule,
  ScalarLeafsRule,
  ValuesOfCorrectTypeRule,
  VariablesAreInputTypesRule,
  VariablesInAllowedPositionRule,
} = require(`graphql`)

import { getGatsbyDependents } from "../utils/gatsby-dependents"
const { store } = require(`../redux`)
import { actions } from "../redux/actions"

import { websocketManager } from "../utils/websocket-manager"
import { getPathToLayoutComponent } from "gatsby-core-utils"
const { default: FileParser } = require(`./file-parser`)
const {
  graphqlError,
  multipleRootQueriesError,
  duplicateFragmentError,
  unknownFragmentError,
} = require(`./graphql-errors`)
const report = require(`gatsby-cli/lib/reporter`)
const {
  default: errorParser,
  locInGraphQlToLocInFile,
} = require(`./error-parser`)

const overlayErrorID = `graphql-compiler`

export default async function compile({ parentSpan } = {}): Promise<
  Map<string, RootQuery>
> {
  const { program, schema, flattenedPlugins } = store.getState()

  const activity = report.activityTimer(`extract queries from components`, {
    parentSpan,
    id: `query-extraction`,
  })
  activity.start()

  const errors = []
  const addError = errors.push.bind(errors)

  const parsedQueries = await parseQueries({
    base: program.directory,
    additional: resolveThemes(
      flattenedPlugins.map(plugin => {
        return {
          themeDir: plugin.pluginFilepath,
        }
      })
    ),
    addError,
    parentSpan: activity.span,
  })

  const queries = processQueries({
    schema,
    parsedQueries,
    addError,
    parentSpan: activity.span,
  })

  if (errors.length !== 0) {
    const structuredErrors = activity.panicOnBuild(errors)
    if (process.env.gatsby_executing_command === `develop`) {
      websocketManager.emitError(overlayErrorID, structuredErrors)
    }
  } else {
    if (process.env.gatsby_executing_command === `develop`) {
      // emitError with `null` as 2nd param to clear browser error overlay
      websocketManager.emitError(overlayErrorID, null)
    }
  }
  activity.end()

  return queries
}

export const resolveThemes = (themes = []) =>
  themes.reduce((merged, theme) => {
    merged.push(theme.themeDir)
    return merged
  }, [])

export const parseQueries = async ({
  base,
  additional,
  addError,
  parentSpan,
}) => {
  const filesRegex = `*.+(t|j)s?(x)`
  // Pattern that will be appended to searched directories.
  // It will match any .js, .jsx, .ts, and .tsx files, that are not
  // inside <searched_directory>/node_modules.
  const pathRegex = `/{${filesRegex},!(node_modules)/**/${filesRegex}}`

  const modulesThatUseGatsby = await getGatsbyDependents()

  let files = [
    path.join(base, `src`),
    path.join(base, `.cache`, `fragments`),
    ...additional.map(additional => path.join(additional, `src`)),
    ...modulesThatUseGatsby.map(module => module.path),
  ].reduce((merged, folderPath) => {
    merged.push(
      ...glob.sync(path.join(folderPath, pathRegex), {
        nodir: true,
      })
    )
    return merged
  }, [])

  files = files.filter(d => !d.match(/\.d\.ts$/))

  files = files.map(normalize)

  // We should be able to remove the following and preliminary tests do suggest
  // that they aren't needed anymore since we transpile node_modules now
  // However, there could be some cases (where a page is outside of src for example)
  // that warrant keeping this and removing later once we have more confidence (and tests)

  // Ensure all page components added as they're not necessarily in the
  // pages directory e.g. a plugin could add a page component. Plugins
  // *should* copy their components (if they add a query) to .cache so that
  // our babel plugin to remove the query on building is active.
  // Otherwise the component will throw an error in the browser of
  // "graphql is not defined".
  files = files.concat(
    Array.from(store.getState().components.keys(), c => normalize(c))
  )

  files = _.uniq(files)

  const parser = new FileParser({ parentSpan: parentSpan })

  return await parser.parseFiles(files, addError)
}

export const processQueries = ({
  schema,
  parsedQueries,
  addError,
  parentSpan,
}) => {
  const { definitionsByName, operations } = extractOperations(
    schema,
    parsedQueries,
    addError,
    parentSpan
  )

  store.dispatch(actions.setGraphQLDefinitions(definitionsByName))

  return processDefinitions({
    schema,
    operations,
    definitionsByName,
    addError,
    parentSpan,
  })
}

const preValidationRules = [
  LoneAnonymousOperationRule,
  FragmentsOnCompositeTypesRule,
  VariablesAreInputTypesRule,
  ScalarLeafsRule,
  PossibleFragmentSpreadsRule,
  ValuesOfCorrectTypeRule,
  VariablesInAllowedPositionRule,
]

const extractOperations = (schema, parsedQueries, addError, parentSpan) => {
  const definitionsByName = new Map()
  const operations = []

  for (const {
    filePath,
    text,
    templateLoc,
    hash,
    doc,
    isHook,
    isStaticQuery,
    isConfigQuery,
  } of parsedQueries) {
    const errors = validate(schema, doc, preValidationRules)

    if (errors && errors.length) {
      addError(
        ...errors.map(error => {
          const location = {
            start: locInGraphQlToLocInFile(templateLoc, error.locations[0]),
          }
          return errorParser({
            message: error.message,
            filePath,
            location,
            error,
          })
        })
      )

      store.dispatch(
        actions.queryExtractionGraphQLError({
          componentPath: filePath,
        })
      )
      // Something is super wrong with this document, so we report it and skip
      continue
    }

    doc.definitions.forEach((def: any) => {
      const name = def.name.value
      let printedAst = null
      if (def.kind === Kind.OPERATION_DEFINITION) {
        operations.push({
          def,
          filePath,
          templatePath: getPathToLayoutComponent(filePath),
          hash,
        })
      } else if (def.kind === Kind.FRAGMENT_DEFINITION) {
        // Check if we already registered a fragment with this name
        printedAst = print(def)
        if (definitionsByName.has(name)) {
          const otherDef = definitionsByName.get(name)
          // If it's not an accidental duplicate fragment, but is a different
          // one - we report an error
          if (printedAst !== otherDef.printedAst) {
            addError(
              duplicateFragmentError({
                name,
                leftDefinition: {
                  def,
                  filePath,
                  text,
                  templateLoc,
                },
                rightDefinition: otherDef,
              })
            )
            // We won't know which one to use, so it's better to fail both of
            // them.
            definitionsByName.delete(name)
          }
          return
        }
      }

      definitionsByName.set(name, {
        name,
        def,
        filePath,
        text: text,
        templateLoc,
        printedAst,
        isHook,
        isStaticQuery,
        isConfigQuery,
        isFragment: def.kind === Kind.FRAGMENT_DEFINITION,
        hash: hash,
        templatePath: getPathToLayoutComponent(filePath),
      })
    })
  }

  return {
    definitionsByName,
    operations,
  }
}

const processDefinitions = ({
  schema,
  operations,
  definitionsByName,
  addError,
  parentSpan,
}) => {
  const processedQueries: Queries = new Map()

  const fragmentsUsedByFragment = new Map()

  const fragmentNames = Array.from(definitionsByName.entries())
    .filter(([_, def]) => def.isFragment)
    .map(([name, _]) => name)

  for (const operation of operations) {
    const { filePath, templatePath, def } = operation
    const name = def.name.value
    const originalDefinition = definitionsByName.get(name)

    const { usedFragments, missingFragments } =
      determineUsedFragmentsForDefinition(
        originalDefinition,
        definitionsByName,
        fragmentsUsedByFragment
      )

    if (missingFragments.length > 0) {
      for (const { filePath, definition, node } of missingFragments) {
        store.dispatch(
          actions.queryExtractionGraphQLError({
            componentPath: filePath,
          })
        )
        addError(
          unknownFragmentError({
            fragmentNames,
            filePath,
            definition,
            node,
          })
        )
      }
      continue
    }

    const document = {
      kind: Kind.DOCUMENT,
      definitions: Array.from(usedFragments.values())
        .map(name => definitionsByName.get(name).def)
        .concat([operation.def]),
    }

    const errors = validate(schema, document)

    if (errors && errors.length) {
      for (const error of errors) {
        const { formattedMessage, message } = graphqlError(
          definitionsByName,
          error
        )

        const filePath = originalDefinition.filePath
        store.dispatch(
          actions.queryExtractionGraphQLError({
            componentPath: filePath,
            error: formattedMessage,
          })
        )
        const location = locInGraphQlToLocInFile(
          originalDefinition.templateLoc,
          error.locations[0]
        )
        addError(
          errorParser({
            location: {
              start: location,
              end: location,
            },
            message,
            filePath,
            error,
          })
        )
      }
      continue
    }

    const printedDocument = print(document)
    // Check for duplicate page/static queries in the same component.
    // (config query is not a duplicate of page/static query in the component)
    // TODO: make sure there is at most one query type per component (e.g. one config + one page)
    if (processedQueries.has(filePath) && !originalDefinition.isConfigQuery) {
      const otherQuery = processedQueries.get(filePath)

      if (
        templatePath !== otherQuery.templatePath ||
        printedDocument !== otherQuery.text
      ) {
        addError(
          multipleRootQueriesError(
            filePath,
            originalDefinition.def,
            otherQuery && definitionsByName.get(otherQuery.name).def
          )
        )

        store.dispatch(
          actions.queryExtractionGraphQLError({
            componentPath: filePath,
          })
        )
        continue
      }
    }

    const query = {
      name,
      text: printedDocument,
      originalText: originalDefinition.text,
      path: filePath,
      isHook: originalDefinition.isHook,
      isStaticQuery: originalDefinition.isStaticQuery,
      isConfigQuery: originalDefinition.isConfigQuery,
      templatePath,
      // ensure hash should be a string and not a number
      hash: String(originalDefinition.hash),
    }

    if (query.isStaticQuery) {
      query.id =
        `sq--` +
        _.kebabCase(
          `${path.relative(store.getState().program.directory, filePath)}`
        )
    }

    if (
      query.isHook &&
      process.env.NODE_ENV === `production` &&
      typeof require(`react`).useContext !== `function`
    ) {
      report.panicOnBuild(
        `You're likely using a version of React that doesn't support Hooks\n` +
          `Please update React and ReactDOM to 16.8.0 or later to use the useStaticQuery hook.`
      )
    }

    // Our current code only supports single graphql query per file (page or static query per file)
    // So, not adding config query because it can overwrite existing page query
    // TODO: allow multiple queries in single file, while preserving limitation of a single page query per file
    if (!query.isConfigQuery) {
      processedQueries.set(filePath, query)
    }
  }

  return processedQueries
}

const determineUsedFragmentsForDefinition = (
  definition,
  definitionsByName,
  fragmentsUsedByFragment,
  traversalPath = []
) => {
  const { def, name, isFragment, filePath } = definition
  const cachedUsedFragments = fragmentsUsedByFragment.get(name)
  if (cachedUsedFragments) {
    return { usedFragments: cachedUsedFragments, missingFragments: [] }
  } else {
    const usedFragments = new Set()
    const missingFragments = []
    visit(def, {
      [Kind.FRAGMENT_SPREAD]: node => {
        const name = node.name.value
        const fragmentDefinition = definitionsByName.get(name)
        if (fragmentDefinition) {
          if (traversalPath.includes(name)) {
            // Already visited this fragment during current traversal.
            //   Visiting it again will cause a stack overflow
            return
          }
          traversalPath.push(name)
          usedFragments.add(name)
          const {
            usedFragments: usedFragmentsForFragment,
            missingFragments: missingFragmentsForFragment,
          } = determineUsedFragmentsForDefinition(
            fragmentDefinition,
            definitionsByName,
            fragmentsUsedByFragment,
            traversalPath
          )
          traversalPath.pop()
          usedFragmentsForFragment.forEach(fragmentName =>
            usedFragments.add(fragmentName)
          )
          missingFragments.push(...missingFragmentsForFragment)
        } else {
          missingFragments.push({
            filePath,
            definition,
            node,
          })
        }
      },
    })
    if (isFragment) {
      fragmentsUsedByFragment.set(name, usedFragments)
    }
    return { usedFragments, missingFragments }
  }
}
