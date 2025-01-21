var after = require('after')
var assert = require('assert')
var Buffer = require('safe-buffer').Buffer
var bytes = require('bytes')
var crypto = require('crypto')
var http = require('http')
var request = require('supertest')
var zlib = require('zlib')

var describeHttp2 = describe.skip
try {
  var http2 = require('http2')
  describeHttp2 = describe
} catch (err) {
  if (err) {
    console.log('http2 tests disabled.')
  }
}

var compression = require('..')

/**
 * @const
 * whether current node version has brotli support
 */
var hasBrotliSupport = 'createBrotliCompress' in zlib
var brotli = hasBrotliSupport ? it : it.skip

describe('compression()', function () {
  it('should skip HEAD', function (done) {
    var server = createServer({ threshold: 0 }, function (req, res) {
      res.setHeader('Content-Type', 'text/plain')
      res.end('hello, world')
    })

    request(server)
      .head('/')
      .set('Accept-Encoding', 'gzip')
      .expect(shouldNotHaveHeader('Content-Encoding'))
      .expect(200, done)
  })

  it('should skip unknown accept-encoding', function (done) {
    var server = createServer({ threshold: 0 }, function (req, res) {
      res.setHeader('Content-Type', 'text/plain')
      res.end('hello, world')
    })

    request(server)
      .get('/')
      .set('Accept-Encoding', 'bogus')
      .expect(shouldNotHaveHeader('Content-Encoding'))
      .expect(200, done)
  })

  it('should skip if content-encoding already set', function (done) {
    var server = createServer({ threshold: 0 }, function (req, res) {
      res.setHeader('Content-Type', 'text/plain')
      res.setHeader('Content-Encoding', 'x-custom')
      res.end('hello, world')
    })

    request(server)
      .get('/')
      .set('Accept-Encoding', 'gzip')
      .expect('Content-Encoding', 'x-custom')
      .expect(200, 'hello, world', done)
  })

  it('should set Vary', function (done) {
    var server = createServer({ threshold: 0 }, function (req, res) {
      res.setHeader('Content-Type', 'text/plain')
      res.end('hello, world')
    })

    request(server)
      .get('/')
      .set('Accept-Encoding', 'gzip')
      .expect('Content-Encoding', 'gzip')
      .expect('Vary', 'Accept-Encoding', done)
  })

  it('should set Vary even if Accept-Encoding is not set', function (done) {
    var server = createServer({ threshold: 1000 }, function (req, res) {
      res.setHeader('Content-Type', 'text/plain')
      res.end('hello, world')
    })

    request(server)
      .get('/')
      .expect('Vary', 'Accept-Encoding')
      .expect(shouldNotHaveHeader('Content-Encoding'))
      .expect(200, done)
  })

  it('should not set Vary if Content-Type does not pass filter', function (done) {
    var server = createServer(null, function (req, res) {
      res.setHeader('Content-Type', 'image/jpeg')
      res.end()
    })

    request(server)
      .get('/')
      .expect(shouldNotHaveHeader('Vary'))
      .expect(200, done)
  })

  it('should set Vary for HEAD request', function (done) {
    var server = createServer({ threshold: 0 }, function (req, res) {
      res.setHeader('Content-Type', 'text/plain')
      res.end('hello, world')
    })

    request(server)
      .head('/')
      .set('Accept-Encoding', 'gzip')
      .expect('Vary', 'Accept-Encoding', done)
  })

  it('should transfer chunked', function (done) {
    var server = createServer({ threshold: 0 }, function (req, res) {
      res.setHeader('Content-Type', 'text/plain')
      res.end('hello, world')
    })

    request(server)
      .get('/')
      .set('Accept-Encoding', 'gzip')
      .expect('Transfer-Encoding', 'chunked', done)
  })

  it('should remove Content-Length for chunked', function (done) {
    var server = createServer({ threshold: 0 }, function (req, res) {
      res.setHeader('Content-Type', 'text/plain')
      res.end('hello, world')
    })

    request(server)
      .get('/')
      .expect('Content-Encoding', 'gzip')
      .expect(shouldNotHaveHeader('Content-Length'))
      .expect(200, done)
  })

  it('should work with encoding arguments', function (done) {
    var server = createServer({ threshold: 0 }, function (req, res) {
      res.setHeader('Content-Type', 'text/plain')
      res.write('hello, ', 'utf8')
      res.end('world', 'utf8')
    })

    request(server)
      .get('/')
      .set('Accept-Encoding', 'gzip')
      .expect('Transfer-Encoding', 'chunked')
      .expect(200, 'hello, world', done)
  })

  it('should allow writing after close', function (done) {
    // UGH
    var server = createServer({ threshold: 0 }, function (req, res) {
      res.setHeader('Content-Type', 'text/plain')
      res.once('close', function () {
        res.write('hello, ')
        res.end('world')
        done()
      })
      res.destroy()
    })

    request(server)
      .get('/')
      .end(function () {})
  })

  it('should back-pressure when compressed', function (done) {
    var buf
    var cb = after(2, done)
    var client
    var drained = false
    var resp
    var server = createServer({ threshold: 0 }, function (req, res) {
      resp = res

      res.on('drain', function () {
        drained = true
      })

      res.setHeader('Content-Type', 'text/plain')
      res.write('start')
      pressure()
    })

    crypto.randomBytes(1024 * 128, function (err, chunk) {
      if (err) return done(err)
      buf = chunk
      pressure()
    })

    function pressure () {
      if (!buf || !resp || !client) return

      assert.ok(!drained)

      while (resp.write(buf) !== false) {
        resp.flush()
      }

      resp.on('drain', function () {
        assert.ok(resp.write('end'))
        resp.end()
      })

      resp.on('finish', cb)
      client.resume()
    }

    request(server)
      .get('/')
      .request()
      .on('response', function (res) {
        client = res
        assert.strictEqual(res.headers['content-encoding'], 'gzip')
        res.pause()
        res.on('end', function () {
          server.close(cb)
        })
        pressure()
      })
      .end()
  })

  it('should back-pressure when uncompressed', function (done) {
    var buf
    var cb = after(2, done)
    var client
    var drained = false
    var resp
    var server = createServer({ filter: function () { return false } }, function (req, res) {
      resp = res

      res.on('drain', function () {
        drained = true
      })

      res.setHeader('Content-Type', 'text/plain')
      res.write('start')
      pressure()
    })

    crypto.randomBytes(1024 * 128, function (err, chunk) {
      if (err) return done(err)
      buf = chunk
      pressure()
    })

    function pressure () {
      if (!buf || !resp || !client) return

      while (resp.write(buf) !== false) {
        resp.flush()
      }

      resp.on('drain', function () {
        assert.ok(drained)
        assert.ok(resp.write('end'))
        resp.end()
      })
      resp.on('finish', cb)
      client.resume()
    }

    request(server)
      .get('/')
      .request()
      .on('response', function (res) {
        client = res
        shouldNotHaveHeader('Content-Encoding')(res)
        res.pause()
        res.on('end', function () {
          server.close(cb)
        })
        pressure()
      })
      .end()
  })

  it('should transfer large bodies', function (done) {
    var len = bytes('1mb')
    var buf = Buffer.alloc(len, '.')
    var server = createServer({ threshold: 0 }, function (req, res) {
      res.setHeader('Content-Type', 'text/plain')
      res.end(buf)
    })

    request(server)
      .get('/')
      .set('Accept-Encoding', 'gzip')
      .expect('Transfer-Encoding', 'chunked')
      .expect('Content-Encoding', 'gzip')
      .expect(shouldHaveBodyLength(len))
      .expect(200, buf.toString(), done)
  })

  it('should transfer large bodies with multiple writes', function (done) {
    var len = bytes('40kb')
    var buf = Buffer.alloc(len, '.')
    var server = createServer({ threshold: 0 }, function (req, res) {
      res.setHeader('Content-Type', 'text/plain')
      res.write(buf)
      res.write(buf)
      res.write(buf)
      res.end(buf)
    })

    request(server)
      .get('/')
      .set('Accept-Encoding', 'gzip')
      .expect('Transfer-Encoding', 'chunked')
      .expect('Content-Encoding', 'gzip')
      .expect(shouldHaveBodyLength(len * 4))
      .expect(200, done)
  })

  describeHttp2('http2', function () {
    it('should work with http2 server', function (done) {
      var server = createHttp2Server({ threshold: 0 }, function (req, res) {
        res.setHeader(http2.constants.HTTP2_HEADER_CONTENT_TYPE, 'text/plain')
        res.end('hello, world')
      })
      server.on('listening', function () {
        var client = createHttp2Client(server.address().port)
        // using ES5 as Node.js <=4.0.0 does not have Computed Property Names
        var reqHeaders = {}
        reqHeaders[http2.constants.HTTP2_HEADER_ACCEPT_ENCODING] = 'gzip'
        var request = client.request(reqHeaders)
        request.on('response', function (headers) {
          assert.strictEqual(headers[http2.constants.HTTP2_HEADER_STATUS], 200)
          assert.strictEqual(headers[http2.constants.HTTP2_HEADER_CONTENT_TYPE], 'text/plain')
          assert.strictEqual(headers[http2.constants.HTTP2_HEADER_CONTENT_ENCODING], 'gzip')
        })
        var chunks = []
        request.on('data', function (chunk) {
          chunks.push(chunk)
        })
        request.on('end', function () {
          closeHttp2(client, server, function () {
            zlib.gunzip(Buffer.concat(chunks), function (err, data) {
              assert.ok(!err)
              assert.strictEqual(data.toString(), 'hello, world')
              done()
            })
          })
        })
        request.end()
      })
    })
  })

  describe('threshold', function () {
    it('should not compress responses below the threshold size', function (done) {
      var server = createServer({ threshold: '1kb' }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.setHeader('Content-Length', '12')
        res.end('hello, world')
      })

      request(server)
        .get('/')
        .set('Accept-Encoding', 'gzip')
        .expect(shouldNotHaveHeader('Content-Encoding'))
        .expect(200, done)
    })

    it('should compress responses above the threshold size', function (done) {
      var server = createServer({ threshold: '1kb' }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.setHeader('Content-Length', '2048')
        res.end(Buffer.alloc(2048))
      })

      request(server)
        .get('/')
        .set('Accept-Encoding', 'gzip')
        .expect('Content-Encoding', 'gzip', done)
    })

    it('should compress when streaming without a content-length', function (done) {
      var server = createServer({ threshold: '1kb' }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.write('hello, ')
        setTimeout(function () {
          res.end('world')
        }, 10)
      })

      request(server)
        .get('/')
        .set('Accept-Encoding', 'gzip')
        .expect('Content-Encoding', 'gzip', done)
    })

    it('should not compress when streaming and content-length is lower than threshold', function (done) {
      var server = createServer({ threshold: '1kb' }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.setHeader('Content-Length', '12')
        res.write('hello, ')
        setTimeout(function () {
          res.end('world')
        }, 10)
      })

      request(server)
        .get('/')
        .set('Accept-Encoding', 'gzip')
        .expect(shouldNotHaveHeader('Content-Encoding'))
        .expect(200, done)
    })

    it('should compress when streaming and content-length is larger than threshold', function (done) {
      var server = createServer({ threshold: '1kb' }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.setHeader('Content-Length', '2048')
        res.write(Buffer.alloc(1024))
        setTimeout(function () {
          res.end(Buffer.alloc(1024))
        }, 10)
      })

      request(server)
        .get('/')
        .set('Accept-Encoding', 'gzip')
        .expect('Content-Encoding', 'gzip', done)
    })

    // res.end(str, encoding) broken in node.js 0.8
    var run = /^v0\.8\./.test(process.version) ? it.skip : it
    run('should handle writing hex data', function (done) {
      var server = createServer({ threshold: 6 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('2e2e2e2e', 'hex')
      })

      request(server)
        .get('/')
        .set('Accept-Encoding', 'gzip')
        .expect(shouldNotHaveHeader('Content-Encoding'))
        .expect(200, '....', done)
    })

    it('should consider res.end() as 0 length', function (done) {
      var server = createServer({ threshold: 1 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end()
      })

      request(server)
        .get('/')
        .set('Accept-Encoding', 'gzip')
        .expect(shouldNotHaveHeader('Content-Encoding'))
        .expect(200, '', done)
    })

    it('should work with res.end(null)', function (done) {
      var server = createServer({ threshold: 1000 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end(null)
      })

      request(server)
        .get('/')
        .set('Accept-Encoding', 'gzip')
        .expect(shouldNotHaveHeader('Content-Encoding'))
        .expect(200, '', done)
    })
  })

  describe('when "Accept-Encoding: gzip"', function () {
    it('should respond with gzip', function (done) {
      var server = createServer({ threshold: 0 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
      })

      request(server)
        .get('/')
        .set('Accept-Encoding', 'gzip')
        .expect('Content-Encoding', 'gzip', done)
    })

    it('should return false writing after end', function (done) {
      var server = createServer({ threshold: 0 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
        assert.ok(res.write() === false)
        assert.ok(res.end() === false)
      })

      request(server)
        .get('/')
        .set('Accept-Encoding', 'gzip')
        .expect('Content-Encoding', 'gzip', done)
    })
  })

  describe('when "Accept-Encoding: deflate"', function () {
    it('should respond with deflate', function (done) {
      var server = createServer({ threshold: 0 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
      })

      request(server)
        .get('/')
        .set('Accept-Encoding', 'deflate')
        .expect('Content-Encoding', 'deflate', done)
    })
  })

  describe('when "Accept-Encoding: br"', function () {
    brotli('should respond with br', function (done) {
      var server = createServer({ threshold: 0 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
      })

      request(server)
        .get('/')
        .set('Accept-Encoding', 'br')
        .expect('Content-Encoding', 'br', done)
    })
  })

  describe('when "Accept-Encoding: br" and passing compression level', function () {
    brotli('should respond with br', function (done) {
      var params = {}
      params[zlib.constants.BROTLI_PARAM_QUALITY] = 11

      var server = createServer({ threshold: 0, brotli: { params: params } }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
      })

      request(server)
        .get('/')
        .set('Accept-Encoding', 'br')
        .expect('Content-Encoding', 'br', done)
    })

    brotli('shouldn\'t break compression when gzip is requested', function (done) {
      var params = {}
      params[zlib.constants.BROTLI_PARAM_QUALITY] = 8

      var server = createServer({ threshold: 0, brotli: { params: params } }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
      })

      request(server)
        .get('/')
        .set('Accept-Encoding', 'gzip')
        .expect('Content-Encoding', 'gzip', done)
    })
  })

  describe('when "Accept-Encoding: gzip, deflate"', function () {
    it('should respond with gzip', function (done) {
      var server = createServer({ threshold: 0 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
      })

      request(server)
        .get('/')
        .set('Accept-Encoding', 'gzip, deflate')
        .expect('Content-Encoding', 'gzip', done)
    })
  })

  describe('when "Accept-Encoding: deflate, gzip"', function () {
    it('should respond with gzip', function (done) {
      var server = createServer({ threshold: 0 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
      })

      request(server)
        .get('/')
        .set('Accept-Encoding', 'deflate, gzip')
        .expect('Content-Encoding', 'gzip', done)
    })
  })

  describe('when "Accept-Encoding: gzip, br"', function () {
    var brotli = hasBrotliSupport ? it : it.skip
    brotli('should respond with br', function (done) {
      var server = createServer({ threshold: 0 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
      })

      request(server)
        .get('/')
        .set('Accept-Encoding', 'gzip, br')
        .expect('Content-Encoding', 'br', done)
    })

    brotli = hasBrotliSupport ? it.skip : it

    brotli('should respond with gzip', function (done) {
      var server = createServer({ threshold: 0 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
      })

      request(server)
        .get('/')
        .set('Accept-Encoding', 'br, gzip')
        .expect('Content-Encoding', 'gzip', done)
    })
  })

  describe('when "Accept-Encoding: deflate, gzip, br"', function () {
    brotli('should respond with br', function (done) {
      var server = createServer({ threshold: 0 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
      })

      request(server)
        .get('/')
        .set('Accept-Encoding', 'deflate, gzip, br')
        .expect('Content-Encoding', 'br', done)
    })
  })

  describe('when "Accept-Encoding: gzip;q=1, br;q=0.3"', function () {
    brotli('should respond with gzip', function (done) {
      var server = createServer({ threshold: 0 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
      })

      request(server)
        .get('/')
        .set('Accept-Encoding', 'gzip;q=1, br;q=0.3')
        .expect('Content-Encoding', 'gzip', done)
    })
  })

  describe('when "Accept-Encoding: gzip, br;q=0.8"', function () {
    brotli('should respond with gzip', function (done) {
      var server = createServer({ threshold: 0 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
      })

      request(server)
        .get('/')
        .set('Accept-Encoding', 'gzip, br;q=0.8')
        .expect('Content-Encoding', 'gzip', done)
    })
  })

  describe('when "Accept-Encoding: gzip;q=0.001"', function () {
    brotli('should respond with gzip', function (done) {
      var server = createServer({ threshold: 0 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
      })

      request(server)
        .get('/')
        .set('Accept-Encoding', 'gzip;q=0.001')
        .expect('Content-Encoding', 'gzip', done)
    })
  })

  describe('when "Accept-Encoding: deflate, br"', function () {
    brotli('should respond with br', function (done) {
      var server = createServer({ threshold: 0 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
      })

      request(server)
        .get('/')
        .set('Accept-Encoding', 'deflate, br')
        .expect('Content-Encoding', 'br', done)
    })
  })

  describe('when "Cache-Control: no-transform" response header', function () {
    it('should not compress response', function (done) {
      var server = createServer({ threshold: 0 }, function (req, res) {
        res.setHeader('Cache-Control', 'no-transform')
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
      })

      request(server)
        .get('/')
        .set('Accept-Encoding', 'gzip')
        .expect('Cache-Control', 'no-transform')
        .expect(shouldNotHaveHeader('Content-Encoding'))
        .expect(200, 'hello, world', done)
    })

    it('should not set Vary headerh', function (done) {
      var server = createServer({ threshold: 0 }, function (req, res) {
        res.setHeader('Cache-Control', 'no-transform')
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
      })

      request(server)
        .get('/')
        .set('Accept-Encoding', 'gzip')
        .expect('Cache-Control', 'no-transform')
        .expect(shouldNotHaveHeader('Vary'))
        .expect(200, done)
    })
  })

  describe('.filter', function () {
    it('should be a function', function () {
      assert.strictEqual(typeof compression.filter, 'function')
    })

    it('should return false on empty response', function (done) {
      var server = http.createServer(function (req, res) {
        res.end(String(compression.filter(req, res)))
      })

      request(server)
        .get('/')
        .expect(200, 'false', done)
    })

    it('should return true for "text/plain"', function (done) {
      var server = http.createServer(function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end(String(compression.filter(req, res)))
      })

      request(server)
        .get('/')
        .expect(200, 'true', done)
    })

    it('should return false for "application/x-bogus"', function (done) {
      var server = http.createServer(function (req, res) {
        res.setHeader('Content-Type', 'application/x-bogus')
        res.end(String(compression.filter(req, res)))
      })

      request(server)
        .get('/')
        .expect(200, 'false', done)
    })
  })

  describe('res.flush()', function () {
    it('should always be present', function (done) {
      var server = createServer(null, function (req, res) {
        res.statusCode = typeof res.flush === 'function'
          ? 200
          : 500
        res.flush()
        res.end()
      })

      request(server)
        .get('/')
        .expect(200, done)
    })

    it('should flush the response', function (done) {
      var chunks = 0
      var next
      var server = createServer({ threshold: 0 }, function (req, res) {
        next = writeAndFlush(res, 2, Buffer.alloc(1024))
        res.setHeader('Content-Type', 'text/plain')
        res.setHeader('Content-Length', '2048')
        next()
      })

      function onchunk (chunk) {
        assert.ok(chunks++ < 2)
        assert.strictEqual(chunk.length, 1024)
        next()
      }

      request(server)
        .get('/')
        .set('Accept-Encoding', 'gzip')
        .request()
        .on('response', unchunk('gzip', onchunk, function (err) {
          if (err) return done(err)
          server.close(done)
        }))
        .end()
    })

    it('should flush small chunks for gzip', function (done) {
      var chunks = 0
      var next
      var server = createServer({ threshold: 0 }, function (req, res) {
        next = writeAndFlush(res, 2, Buffer.from('..'))
        res.setHeader('Content-Type', 'text/plain')
        next()
      })

      function onchunk (chunk) {
        assert.ok(chunks++ < 20)
        assert.strictEqual(chunk.toString(), '..')
        next()
      }

      request(server)
        .get('/')
        .set('Accept-Encoding', 'gzip')
        .request()
        .on('response', unchunk('gzip', onchunk, function (err) {
          if (err) return done(err)
          server.close(done)
        }))
        .end()
    })

    brotli('should flush small chunks for brotli', function (done) {
      var chunks = 0
      var next
      var server = createServer({ threshold: 0 }, function (req, res) {
        next = writeAndFlush(res, 2, Buffer.from('..'))
        res.setHeader('Content-Type', 'text/plain')
        next()
      })

      function onchunk (chunk) {
        assert.ok(chunks++ < 20)
        assert.strictEqual(chunk.toString(), '..')
        next()
      }

      request(server)
        .get('/')
        .set('Accept-Encoding', 'br')
        .request()
        .on('response', unchunk('br', onchunk, function (err) {
          if (err) return done(err)
          server.close(done)
        }))
        .end()
    })

    it('should flush small chunks for deflate', function (done) {
      var chunks = 0
      var next
      var server = createServer({ threshold: 0 }, function (req, res) {
        next = writeAndFlush(res, 2, Buffer.from('..'))
        res.setHeader('Content-Type', 'text/plain')
        next()
      })

      function onchunk (chunk) {
        assert.ok(chunks++ < 20)
        assert.strictEqual(chunk.toString(), '..')
        next()
      }

      request(server)
        .get('/')
        .set('Accept-Encoding', 'deflate')
        .request()
        .on('response', unchunk('deflate', onchunk, function (err) {
          if (err) return done(err)
          server.close(done)
        }))
        .end()
    })
  })

  describe('enforceEncoding', function () {
    it('should compress the provided encoding and not the default encoding', function (done) {
      var server = createServer({ threshold: 0, enforceEncoding: 'deflate' }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
      })

      request(server)
        .get('/')
        .set('Accept-Encoding', 'gzip')
        .expect('Content-Encoding', 'gzip')
        .expect(200, 'hello, world', done)
    })

    it('should not compress when enforceEncoding is identity', function (done) {
      var server = createServer({ threshold: 0, enforceEncoding: 'identity' }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
      })

      request(server)
        .get('/')
        .set('Accept-Encoding', '')
        .expect(shouldNotHaveHeader('Content-Encoding'))
        .expect(200, 'hello, world', done)
    })

    it('should compress when enforceEncoding is gzip', function (done) {
      var server = createServer({ threshold: 0, enforceEncoding: 'gzip' }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
      })

      request(server)
        .get('/')
        .set('Accept-Encoding', '')
        .expect('Content-Encoding', 'gzip')
        .expect(200, 'hello, world', done)
    })

    it('should compress when enforceEncoding is deflate', function (done) {
      var server = createServer({ threshold: 0, enforceEncoding: 'deflate' }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
      })

      request(server)
        .get('/')
        .set('Accept-Encoding', '')
        .expect('Content-Encoding', 'deflate')
        .expect(200, 'hello, world', done)
    })

    brotli('should compress when enforceEncoding is brotli', function (done) {
      var server = createServer({ threshold: 0, enforceEncoding: 'br' }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
      })

      request(server)
        .get('/')
        .set('Accept-Encoding', '')
        .expect('Content-Encoding', 'br')
        .expect(200, done)
    })

    it('should not compress when enforceEncoding is unknown', function (done) {
      var server = createServer({ threshold: 0, enforceEncoding: 'bogus' }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
      })

      request(server)
        .get('/')
        .set('Accept-Encoding', '')
        .expect(shouldNotHaveHeader('Content-Encoding'))
        .expect(200, 'hello, world', done)
    })

    it('should not compress when enforceEnconding is *', function (done) {
      var server = createServer({ threshold: 0, enforceEncoding: '*' }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
      })

      request(server)
        .get('/')
        .set('Accept-Encoding', '')
        .expect(shouldNotHaveHeader('Content-Encoding'))
        .expect(200, done)
    })
  })
})

function createServer (opts, fn) {
  var _compression = compression(opts)
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
  var _compression = compression(opts)
  var server = http2.createServer(function (req, res) {
    _compression(req, res, function (err) {
      if (err) {
        res.statusCode = err.status || 500
        res.end(err.message)
        return
      }

      fn(req, res)
    })
  })
  server.listen(0, '127.0.0.1')
  return server
}

function createHttp2Client (port) {
  return http2.connect('http://127.0.0.1:' + port)
}

function closeHttp2 (client, server, callback) {
  if (typeof client.shutdown === 'function') {
    // this is the node v8.x way of closing the connections
    client.shutdown({}, function () {
      server.close(function () {
        callback()
      })
    })
  } else {
    // this is the node v9.x onwards way of closing the connections
    client.close(function () {
      // force existing connections to time out after 1ms.
      // this is done to force the server to close in some cases where it wouldn't do it otherwise.
      server.close(function () {
        callback()
      })
    })
  }
}

function shouldHaveBodyLength (length) {
  return function (res) {
    assert.strictEqual(res.text.length, length, 'should have body length of ' + length)
  }
}

function shouldNotHaveHeader (header) {
  return function (res) {
    assert.ok(!(header.toLowerCase() in res.headers), 'should not have header ' + header)
  }
}

function writeAndFlush (stream, count, buf) {
  var writes = 0

  return function () {
    if (writes++ >= count) return
    if (writes === count) return stream.end(buf)
    stream.write(buf)
    stream.flush()
  }
}

function unchunk (encoding, onchunk, onend) {
  return function (res) {
    var stream

    assert.strictEqual(res.headers['content-encoding'], encoding)

    switch (encoding) {
      case 'deflate':
        stream = res.pipe(zlib.createInflate())
        break
      case 'gzip':
        stream = res.pipe(zlib.createGunzip())
        break
      case 'br':
        stream = res.pipe(zlib.createBrotliDecompress())
        break
    }

    stream.on('data', onchunk)
    stream.on('end', onend)
  }
}
