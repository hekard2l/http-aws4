#!/usr/bin/env node

const AWS = require('aws-sdk')
const normalizeUrl = require('normalize-url')
const lowercaseKeys = require('lowercase-keys')
const chalk = require('chalk')
const emphasize = require('emphasize')
const cleanStack = require('clean-stack')
const getStdin = require('get-stdin')
const pify = require('pify')
const yargs = require('yargs')
const pkg = require('./package.json')

const USER_AGENT = `${pkg.name}/${pkg.version} (https://github.com/${pkg.repository})`

const CONSOLE_COLORS = [
  ['log', 'blue'],
  ['info', 'green'],
  ['warn', 'yellow'],
  ['error', 'red']
]

const argv = yargs
  .demand(1)
  .usage('Usage: $0 [options] [method] <url>')
  .version()
  .help()
  .options({
    print: {
      description: 'Parts of the request and response to output',
      alias: 'p',
      requiresArg: true,
      default: process.stdout.isTTY ? 'hb' : 'b',
      coerce: (val) => {
        if (!/^[HBhb]+$/.test(val)) {
          throw new Error('Allowed flags: HBhb')
        }
        return val
      }
    },
    pretty: {
      description: 'Output formatting',
      requiresArg: true,
      choices: ['all', 'colors', 'format', 'none'],
      default: process.stdout.isTTY ? 'all' : 'none'
    },
    region: {
      description: 'AWS region',
      alias: 'r',
      requiresArg: true,
      default: null,
      defaultDescription: '<auto>'
    },
    profile: {
      description: 'AWS profile',
      requiresArg: true,
      default: null
    },
    service: {
      description: 'AWS service name',
      alias: 's',
      requiresArg: true,
      default: null,
      defaultDescription: '<auto>'
    }
  })
  .argv

const args = argv._
let service, method, url, region

if (/^\w+$/.test(args[0])) {
  method = args.shift().toUpperCase()
  url = args.shift()
} else {
  url = args.shift()
  method = 'GET'
}

url = normalizeUrl(url, {
  stripWWW: false,
  removeQueryParameters: null
})

region = argv.region
if (region == null) {
  region = /([a-z0-9-]+)\.\w+\.amazonaws\.com(?:\/|:|$)/i.exec(url)[1]
}

service = argv.service
if (service == null) {
  service = /(\w+)\.amazonaws\.com(?:\/|:|$)/i.exec(url)[1]
}

const headers = {}
while (args.length > 0) {
  const arg = args.shift()
  const pos = arg.indexOf(':')
  headers[arg.substr(0, pos).toLowerCase()] = arg.substr(pos + 1)
}

const config = new AWS.Config({region})
const client = new AWS.NodeHttpClient()

const logger = CONSOLE_COLORS.reduce((logger, [fn, color]) => {
  const fmt = chalk[color]
  logger[fn] = (...args) => {
    console[fn].apply(console, args.map((arg) => fmt(arg)))
  }
  logger[fn].bare = (...args) => {
    console[fn].apply(console, args)
  }
  return logger
}, {})

const formatHeaders = (headers, type) => {
  for (const name of Object.keys(headers).sort()) {
    logger[type](`${name}: ${headers[name]}`)
  }
}

const indent = (code, resp) => {
  if (resp.headers && /\bjson\b/.test(resp.headers['content-type'])) {
    try {
      return JSON.stringify(JSON.parse(code), null, 2)
    } catch (err) {}
  }
  return code
}

const highlight = (code, resp) => {
  // TODO Convert MIME type to highlight.js language
  if (resp.headers && !/^text\/plain\b/.test(resp.headers['content-type'])) {
    try {
      return emphasize.highlightAuto(code).value
    } catch (err) {}
  }
  return code
}

const formatResponse = (resp, type = 'info') => {
  if (~argv.print.indexOf('h')) {
    logger[type](chalk.bold(`${resp.statusCode} ${resp.statusMessage}`))
    if (resp.headers) {
      formatHeaders(resp.headers, type)
      logger[type]()
    }
  }
  if (~argv.print.indexOf('b')) {
    if (resp.body == null || resp.body.length === 0) {
      logger[type]('')
    } else if (argv.pretty === 'none') {
      logger[type](resp.body.toString())
    } else {
      const transforms = []
      if (argv.pretty === 'all' || argv.pretty === 'format') {
        transforms.push(indent)
      }
      if (argv.pretty === 'all' || argv.pretty === 'colors') {
        transforms.push(highlight)
      }
      const output = transforms.reduce((prev, transform) => transform(prev, resp),
        resp.body.toString())
      logger[type].bare(output)
    }
  }
}

const handleError = (err) => {
  if (err.response != null) {
    formatResponse(err.response, 'error')
  } else {
    logger.error(cleanStack(err.stack))
  }
  process.exit(1)
}

const createRequest = (method, url, body, credentials) => {
  const endpoint = new AWS.Endpoint(url)
  const request = Object.assign(new AWS.HttpRequest(endpoint), {
    region,
    method,
    body
  })
  request.headers = Object.assign(
    lowercaseKeys(request.headers),
    {'user-agent': USER_AGENT},
    headers,
    {host: endpoint.host})
  const signer = new AWS.Signers.V4(request, service)
  signer.addAuthorization(credentials, new Date())
  return request
}

const handleRequest = (request, body) => new Promise((resolve, reject) => {
  if (~argv.print.indexOf('H')) {
    logger.log(chalk.bold(`${request.method} ${request.endpoint.href}`))
    formatHeaders(request.headers, 'log')
    logger.log()
  }
  if (~argv.print.indexOf('B')) {
    logger.log((body != null) ? body.toString().trimRight() : '')
    logger.log()
  }
  client.handleRequest(request, null, resolve, reject)
})

const handleResponse = (response) => new Promise((resolve, reject) => {
  response.setEncoding('utf8')
  const metadata = {
    statusCode: response.statusCode,
    statusMessage: response.statusMessage,
    headers: response.headers,
    body: ''
  }
  response.on('data', (data) => {
    metadata.body += data
  })
  response.on('end', () => {
    if (metadata.statusCode < 200 || metadata.statusCode >= 300) {
      const error = new Error()
      error.response = metadata
      reject(error)
    } else {
      resolve(metadata)
    }
  })
  response.on('error', reject)
})

const getCredentials = (argv.profile) ?
  () => Promise.resolve(new AWS.SharedIniFileCredentials({ profile: argv.profile })) :
  pify(config.getCredentials).bind(config)

Promise.all([getStdin(), getCredentials()])
  .then(([body, credentials]) => {
    const request = createRequest(method, url, body, credentials)
    return handleRequest(request, body)
  })
  .then(handleResponse)
  .then(formatResponse)
  .catch(handleError)
