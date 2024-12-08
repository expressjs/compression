const compression = require('..')
const http = require('http')
var http2

try {
  http2 = require('http2')
} catch (_err) {
  // Nothing
  console.log('http2 tests disabled.')
}

function createHTTPServer (opts, fn) {
  const _compression = compression(opts)

  return http.createServer(function (req, res) {
    _compression(req, res, function (err) {
      if (err) {
        res.statusCode = err.status || 500
        res.end(err.message)
        return
      }

      fn(req, res)
    })
  })
}

function createHttp2Server (opts, fn) {
  const _compression = compression(opts)

  return http2.createServer(function (req, res) {
    _compression(req, res, function (err) {
      if (err) {
        res.statusCode = err.status || 500
        res.end(err.message)
        return
      }

      fn(req, res)
    })
  })
}

exports.createHTTPServer = createHTTPServer
exports.createHttp2Server = createHttp2Server
