const program = require('commander')
const fs = require('fs')
const moment = require('moment')
const path = require('path')

const db = require('../shared/db')
const paths = require('../shared/paths')
const routes = require('../shared/routes')
const utils = require('../shared/utils')

program
  .option('-y, --yes', 'Automatically execute cleanup without confirmation')
  .option('-v, --verbose', 'Verbose logging')
  .option('-m, --maxage', 'Discard requests older than specified age (supports ISO 8601 durations), defaults to 1 year')
  .parse(process.argv)

async function cleanupRequests (yes, verbose) {
  console.log('Scanning search requests...')
  const requests = []
  const associatedFiles = new Set()
  await db.db().each('SELECT * FROM awards_requests', (err, row) => {
    if (err) {
      throw new Error('Could not scan search requests: ' + err)
    }

    // Check for any missing resources
    const assets = utils.assetsForRequest(row)
    const missing = !!assets.htmlFiles.find(x => !fs.existsSync(x))

    // Keep track of every file associated with a request
    assets.htmlFiles.forEach(x => associatedFiles.add(x))
    assets.screenshots.forEach(x => associatedFiles.add(x))

    // If any files were missing, cleanup the request
    if (missing) {
      requests.push(row)
      if (verbose) {
        console.log(JSON.stringify(row, null, 4))
      }
    }
  })

  // Check what we found
  if (requests.length === 0) {
    console.log('No incomplete requests were found!')
    return { requests, associatedFiles }
  }

  // Prompt user to cleanup requests
  if (yes || utils.promptYesNo(`Found ${requests.length} incomplete requests. Delete them from the database?`)) {
    console.log('Cleaning up database entries and associated resources...')
    for (const row of requests) {
      await utils.cleanupRequest(row)
    }
    return { requests, associatedFiles }
  }
  return { requests: [], associatedFiles }
}

async function cleanupResources (yes, verbose, associatedFiles) {
  // Iterate over resources
  console.log('Scanning data resources...')
  let resources = fs.readdirSync(paths.data)

  // Ignore hidden files
  resources = resources.filter(x => !x.startsWith('.'))

  // Make paths relative from main directory
  resources = resources.map(x => path.join(paths.data, x))

  // Get the list of files which are not associated with a request
  resources = resources.filter(x => !associatedFiles.has(x))

  // Print orphaned resources if verbose
  if (verbose) {
    resources.forEach(x => console.log('    ' + x))
  }

  // Check what we found
  if (resources.length === 0) {
    console.log('No orphaned resources were found!')
    return { resources }
  }

  // Prompt user to cleanup resources
  if (yes || utils.promptYesNo(`Found ${resources.length} orphaned resources. Delete them from disk?`)) {
    console.log('Cleaning up orphaned resources...')
    for (const filename of resources) {
      if (fs.existsSync(filename)) {
        fs.unlinkSync(filename)
      }
    }
    return { resources }
  }
  return { resources: [] }
}

async function cleanupRedundant (yes, verbose, cutoff) {
  console.log('Scanning for redundant requests...')
  const inUse = new Set()
  const requests = []

  // Lookup all active routes from database
  const allRoutes = await routes.find()
  for (const val of allRoutes.values()) {
    // Compute most recent request for every quantity value
    const map = val.requests.reduce((map, x) => {
      requests.push(x)
      const updatedAt = moment(x.updatedAt)
      if (updatedAt.isSameOrAfter(cutoff)) {
        const old = map.get(x.quantity)
        if (!old || updatedAt.isAfter(moment(old.updatedAt))) {
          map.set(x.quantity, x)
        }
      }
      return map
    }, new Map())

    // Add those requests to in-use set
    map.forEach(x => inUse.add(x.id))
  }

  // Find requests that are no longer in use
  const redundant = requests.filter(x => !inUse.has(x.id))
  if (verbose) {
    redundant.forEach(x => console.log(JSON.stringify(x, null, 4)))
  }

  // Check what we found
  if (redundant.length === 0) {
    console.log('No redundant requests were found!')
    return { redundant }
  }

  // Prompt user to cleanup requests
  if (yes || utils.promptYesNo(`Found ${redundant.length} redundant requests. Delete them from the database?`)) {
    console.log('Cleaning up database entries and associated resources...')
    for (const row of redundant) {
      await utils.cleanupRequest(row)
    }
    return { redundant }
  }
  return { redundant: [] }
}

const main = async (args) => {
  const { yes, verbose, maxage = 'P1Y' } = args

  try {
    // Open the database
    console.log('Opening database...')
    await db.open()

    // Cleanup requests
    const { requests, associatedFiles } = await cleanupRequests(yes, verbose)

    // Cleanup resources
    const { resources } = await cleanupResources(yes, verbose, associatedFiles)

    // Cleanup redundant requests
    const cutoff = moment().subtract(moment.duration(maxage))
    const { redundant } = await cleanupRedundant(yes, verbose, cutoff)

    // Print summary
    console.log('')
    console.log('Cleanup Report:')
    console.log('    Deleted Requests: ' + requests.length)
    console.log('    Deleted Resources: ' + resources.length)
    console.log('    Redundant Requests: ' + redundant.length)
  } catch (e) {
    console.error(e)
    process.exit(1)
  } finally {
    await db.close()
  }
}

main(program)
