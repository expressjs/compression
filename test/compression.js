var assert = require('assert')
var bytes = require('bytes');
var crypto = require('crypto');
var http = require('http');
var iltorb = require('iltorb');
var streamBuffers = require('stream-buffers');
var request = require('supertest');
var zlib = require('zlib');

var compression = require('..')

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

    gzipRequest(server)
    .expect('Content-Encoding', 'x-custom')
    .expect(200, 'hello, world', done)
  })

  it('should set Vary', function (done) {
    var server = createServer({ threshold: 0 }, function (req, res) {
      res.setHeader('Content-Type', 'text/plain')
      res.end('hello, world')
    })

    gzipRequest(server)
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

    gzipRequest(server)
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

    gzipRequest(server)
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
    var wait = 2

    crypto.pseudoRandomBytes(1024 * 128, function (err, chunk) {
      if (err) return done(err)
      buf = chunk
      pressure()
    })

    function complete () {
      if (--wait !== 0) return
      assert.ok(drained)
      done()
    }

    function pressure () {
      if (!buf || !resp || !client) return

      while (resp.write(buf) !== false) {
        resp.flush()
      }

      resp.on('drain', function () {
        resp.write('end')
        resp.end()
      })
      resp.on('finish', complete)
      client.resume()
    }

    request(server)
    .get('/')
    .request()
    .on('response', function (res) {
      client = res
      assert.equal(res.headers['content-encoding'], 'gzip')
      res.pause()
      res.on('end', complete)
      pressure()
    })
    .end()
  })

  it('should back-pressure when uncompressed', function (done) {
    var buf
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
    var wait = 2

    crypto.pseudoRandomBytes(1024 * 128, function (err, chunk) {
      if (err) return done(err)
      buf = chunk
      pressure()
    })

    function complete () {
      if (--wait !== 0) return
      assert.ok(drained)
      done()
    }

    function pressure () {
      if (!buf || !resp || !client) return

      while (resp.write(buf) !== false) {
        resp.flush()
      }

      resp.on('drain', function () {
        resp.write('end')
        resp.end()
      })
      resp.on('finish', complete)
      client.resume()
    }

    request(server)
    .get('/')
    .request()
    .on('response', function (res) {
      client = res
      shouldNotHaveHeader('Content-Encoding')(res)
      res.pause()
      res.on('end', complete)
      pressure()
    })
    .end()
  })

  it('should transfer large bodies', function (done) {
    var len = bytes('1mb')
    var buf = new Buffer(len)
    var server = createServer({ threshold: 0 }, function (req, res) {
      res.setHeader('Content-Type', 'text/plain')
      res.end(buf)
    })

    buf.fill('.')

    gzipRequest(server)
    .expect('Transfer-Encoding', 'chunked')
    .expect('Content-Encoding', 'gzip')
    .expect(shouldHaveBodyLength(len))
    .expect(200, buf.toString(), done)
  })

  it('should transfer large bodies with multiple writes', function (done) {
    var len = bytes('40kb')
    var buf = new Buffer(len)
    var server = createServer({ threshold: 0 }, function (req, res) {
      res.setHeader('Content-Type', 'text/plain')
      res.write(buf)
      res.write(buf)
      res.write(buf)
      res.end(buf)
    })

    buf.fill('.')

    gzipRequest(server)
    .expect('Transfer-Encoding', 'chunked')
    .expect('Content-Encoding', 'gzip')
    .expect(shouldHaveBodyLength(len * 4))
    .expect(200, done)
  })

  describe('threshold', function () {
    it('should not compress responses below the threshold size', function (done) {
      var server = createServer({ threshold: '1kb' }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.setHeader('Content-Length', '12')
        res.end('hello, world')
      })

      gzipRequest(server)
      .expect(shouldNotHaveHeader('Content-Encoding'))
      .expect(200, done)
    })

    it('should compress responses above the threshold size', function (done) {
      var server = createServer({ threshold: '1kb' }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.setHeader('Content-Length', '2048')
        res.end(new Buffer(2048))
      })

      gzipRequest(server).expect('Content-Encoding', 'gzip', done)
    })

    it('should compress when streaming without a content-length', function (done) {
      var server = createServer({ threshold: '1kb' }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.write('hello, ')
        setTimeout(function () {
          res.end('world')
        }, 10)
      })

      gzipRequest(server).expect('Content-Encoding', 'gzip', done)
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

      gzipRequest(server)
      .expect(shouldNotHaveHeader('Content-Encoding'))
      .expect(200, done)
    })

    it('should compress when streaming and content-length is larger than threshold', function (done) {
      var server = createServer({ threshold: '1kb' }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.setHeader('Content-Length', '2048')
        res.write(new Buffer(1024))
        setTimeout(function () {
          res.end(new Buffer(1024))
        }, 10)
      })

      gzipRequest(server).expect('Content-Encoding', 'gzip', done)
    })

    // res.end(str, encoding) broken in node.js 0.8
    var run = /^v0\.8\./.test(process.version) ? it.skip : it
    run('should handle writing hex data', function (done) {
      var server = createServer({ threshold: 6 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('2e2e2e2e', 'hex')
      })

      gzipRequest(server)
      .expect(shouldNotHaveHeader('Content-Encoding'))
      .expect(200, '....', done)
    })

    it('should consider res.end() as 0 length', function (done) {
      var server = createServer({ threshold: 1 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end()
      })

      gzipRequest(server)
      .expect(shouldNotHaveHeader('Content-Encoding'))
      .expect(200, '', done)
    })

    it('should work with res.end(null)', function (done) {
      var server = createServer({ threshold: 1000 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end(null)
      })

      gzipRequest(server)
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

      gzipRequest(server).expect('Content-Encoding', 'gzip', done)
    })

    it('should return false writing after end', function (done) {
      var server = createServer({ threshold: 0 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
        assert.ok(res.write() === false)
        assert.ok(res.end() === false)
      })

      gzipRequest(server).expect('Content-Encoding', 'gzip', done)
    })
  })

  describe('when "Accept-Encoding: deflate"', function () {
    it('should respond with deflate', function (done) {
      var server = createServer({ threshold: 0 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
      })

      deflateRequest(server).expect('Content-Encoding', 'deflate', done)
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

  describe('when "Accept-Encoding: deflate, gzip, br"', function () {
    it('should respond with brotli', function (done) {
      var server = createServer({ threshold: 0 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
      })

      request(server)
      .get('/')
      .set('Accept-Encoding', 'deflate, gzip, br')
      .expect('Content-Encoding', 'br', done)
    })

    it('should respond with gzip for server-sent events (SSE)', function (done) {
      var server = createServer({ threshold: 0 }, function (req, res) {
        res.setHeader('Content-Type', 'text/event-stream')
        res.end('hello, world')
      })

      request(server)
      .get('/')
      .set('Accept-Encoding', 'deflate, gzip, br')
      .expect('Content-Encoding', 'gzip', done)
    })
  })

  describe('when "Accept-Encoding: br"', function () {
    it('should respond with brotli', function (done) {
      var server = createServer({ threshold: 0 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
      })

      brotliRequest(server).expect('Content-Encoding', 'br', done)
    })

    it('should have a correctly encoded brotli response', function (done) {
      var server = createServer({ threshold: 0 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
      })

      var stream = new streamBuffers.WritableStreamBuffer()

      brotliRequest(server)
      .pipe(stream)
      .on('finish', function () {
        assert.equal('hello, world', iltorb.decompressSync(stream.getContents()).toString('utf-8'))
        done()
      })
    })

    it('should apply the brotli parameters from options', function (done) {
      var server = createServer({ threshold: 0 , brotli: { quality: 8 } }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
      })

      var stream = new streamBuffers.WritableStreamBuffer()

      brotliRequest(server)
      .pipe(stream)
      .on('finish', function () {
        // check to make sure that the response buffer is byte-for-byte equivalent to calling
        // brotli directly with the same quality parameter.
        assertBuffersEqual(
          stream.getContents(),
          iltorb.compressSync(new Buffer('hello, world', 'utf-8'), { quality: 8 }));
        done()
      })
    })

    it('should not throw if flush() is called', function (done) {
      var server = createServer({ threshold: 0 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.write('hello, ');
        res.flush();
        res.end('world')
      })

      brotliRequest(server).expect('Content-Encoding', 'br', done)
    })
  })

  describe('when caching is turned on', function () {
    it('should cache a gzipped response with the same ETag', function (done) {
      var count = 0;
      var server = createServer({ threshold: 0 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.setHeader('ETag', '12345')
        res.end('hello, world #' + count)
        count++
      })

      gzipRequest(server).expect('hello, world #0', function () {
        gzipRequest(server).expect('hello, world #0', done)
      })
    })

    it('should cache a deflate response with the same ETag', function (done) {
      var count = 0;
      var server = createServer({ threshold: 0 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.setHeader('ETag', '12345')
        res.end('hello, world #' + count)
        count++
      })

      deflateRequest(server).expect('hello, world #0', function () {
        deflateRequest(server).expect('hello, world #0', done)
      })
    })

    it('should cache a brotli response with the same ETag', function (done) {
      var count = 0;
      var server = createServer({ threshold: 0, brotli: { quality: 1 }}, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.setHeader('ETag', '12345')
        res.end('hello, world #' + count)
        count++
      })

      var stream = new streamBuffers.WritableStreamBuffer()
      brotliRequest(server)
        .pipe(stream)
        .on('finish', function () {
          assert.equal('hello, world #0', iltorb.decompressSync(stream.getContents()).toString('utf-8'))
          var stream2 = new streamBuffers.WritableStreamBuffer()
          brotliRequest(server)
            .pipe(stream2)
            .on('finish', function() {
              assert.equal('hello, world #0', iltorb.decompressSync(stream2.getContents()).toString('utf-8'))
              done()
            })
        })
    })

    it('should not cache when the cache function returns false', function (done) {
      var count = 0;
      var server = createServer({ threshold: 0, cache: function(req, res) { return false; } }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.setHeader('ETag', '12345')
        res.end('hello, world #' + count)
        count++
      })

      gzipRequest(server).expect('hello, world #0', function () {
        gzipRequest(server).expect('hello, world #1', done)
      })
    })

    it('should not get a cached compressed response for a different ETag', function (done) {
      var count = 0;
      var server = createServer({ threshold: 0 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.setHeader('ETag', count.toString())
        res.end('hello, world #' + count)
        count++
      })

      gzipRequest(server).expect('hello, world #0', function () {
        gzipRequest(server).expect('hello, world #1', done)
      })
    })

    it('should not cache when there is no ETag', function (done) {
      var count = 0;
      var server = createServer({ threshold: 0 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world #' + count)
        count++
      })

      gzipRequest(server).expect('hello, world #0', function () {
        gzipRequest(server).expect('hello, world #1', done)
      })
    })

    it('should not cache when caching is disabled', function (done) {
      var count = 0;
      var server = createServer({ threshold: 0, cacheSize: false }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.setHeader('ETag', '12345')
        res.end('hello, world #' + count)
        count++
      })

      gzipRequest(server).expect('hello, world #0', function () {
        gzipRequest(server).expect('hello, world #1', done)
      })
    })

    it('should evict from the cache when over the limit', function (done) {
      var etag = 'a', count = 0;
      var server = createServer({ threshold: 0, cacheSize: 40 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.setHeader('ETag', etag)
        res.end('hello, world #' + count)
      })

      gzipRequest(server).expect('hello, world #0', function () {
        etag = 'b'
        count = 1
        gzipRequest(server).expect('hello, world #1', function () {
          etag = 'b'
          count = 2
          gzipRequest(server).expect('hello, world #1', function () {
            etag = 'a'
            count = 3
            gzipRequest(server).expect('hello, world #3', done)
          })
        })
      })
    })

    it('should evict the oldest representation from the cache when over the limit', function (done) {
      var etag = 'a', count = 0;
      var server = createServer({ threshold: 0, cacheSize: 80 }, function (req, res) {
        res.setHeader('Content-Type', 'text/plain')
        res.setHeader('ETag', etag)
        res.end('hello, world #' + count)
      })

      gzipRequest(server).expect('hello, world #0', function () {
        etag = 'b'
        count = 1
        gzipRequest(server).expect('hello, world #1', function () {
          etag = 'c'
          count = 2
          gzipRequest(server).expect('hello, world #2', function () {
            etag = 'b'
            count = 3
            gzipRequest(server).expect('hello, world #1', function () {
              etag = 'a'
              count = 4
              gzipRequest(server).expect('hello, world #4', done)
            })
          })
        })
      })
    })
  })

  describe('when "Cache-Control: no-transform" response header', function () {
    it('should not compress response', function (done) {
      var server = createServer({ threshold: 0 }, function (req, res) {
        res.setHeader('Cache-Control', 'no-transform')
        res.setHeader('Content-Type', 'text/plain')
        res.end('hello, world')
      })

      gzipRequest(server)
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

      gzipRequest(server)
      .expect('Cache-Control', 'no-transform')
      .expect(shouldNotHaveHeader('Vary'))
      .expect(200, done)
    })
  })

  describe('.filter', function () {
    it('should be a function', function () {
      assert.equal(typeof compression.filter, 'function')
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
      var resp
      var server = createServer({ threshold: 0 }, function (req, res) {
        resp = res
        res.setHeader('Content-Type', 'text/plain')
        res.setHeader('Content-Length', '2048')
        write()
      })

      function write () {
        chunks++
        if (chunks === 2) return resp.end()
        if (chunks > 2) return chunks--
        resp.write(new Buffer(1024))
        resp.flush()
      }

      gzipRequest(server)
      .request()
      .on('response', function (res) {
        assert.equal(res.headers['content-encoding'], 'gzip')
        res.on('data', write)
        res.on('end', function () {
          assert.equal(chunks, 2)
          done()
        })
      })
      .end()
    })

    it('should flush small chunks for gzip', function (done) {
      var chunks = 0
      var resp
      var server = createServer({ threshold: 0 }, function (req, res) {
        resp = res
        res.setHeader('Content-Type', 'text/plain')
        write()
      })

      function write () {
        chunks++
        if (chunks === 20) return resp.end()
        if (chunks > 20) return chunks--
        resp.write('..')
        resp.flush()
      }

      gzipRequest(server)
      .request()
      .on('response', function (res) {
        assert.equal(res.headers['content-encoding'], 'gzip')
        res.on('data', write)
        res.on('end', function () {
          assert.equal(chunks, 20)
          done()
        })
      })
      .end()
    })

    it('should flush small chunks for deflate', function (done) {
      var chunks = 0
      var resp
      var server = createServer({ threshold: 0 }, function (req, res) {
        resp = res
        res.setHeader('Content-Type', 'text/plain')
        write()
      })

      function write () {
        chunks++
        if (chunks === 20) return resp.end()
        if (chunks > 20) return chunks--
        resp.write('..')
        resp.flush()
      }

      deflateRequest(server)
      .request()
      .on('response', function (res) {
        assert.equal(res.headers['content-encoding'], 'deflate')
        res.on('data', write)
        res.on('end', function () {
          assert.equal(chunks, 20)
          done()
        })
      })
      .end()
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

function shouldHaveBodyLength (length) {
  return function (res) {
    assert.equal(res.text.length, length, 'should have body length of ' + length)
  }
}

function shouldNotHaveHeader (header) {
  return function (res) {
    assert.ok(!(header.toLowerCase() in res.headers), 'should not have header ' + header)
  }
}

function assertBuffersEqual(buffer1, buffer2) {
  assert.equal(buffer1.toString('hex'), buffer2.toString('hex'));
}

function gzipRequest(server) {
  return request(server)
    .get('/')
    .set('Accept-Encoding', 'gzip')
}

function deflateRequest(server) {
  return request(server)
    .get('/')
    .set('Accept-Encoding', 'deflate')
}

function brotliRequest(server) {
  return request(server)
    .get('/')
    .set('Accept-Encoding', 'br')
}
