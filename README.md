# shrink-ray

[![NPM Version][npm-image]][npm-url]
[![NPM Downloads][downloads-image]][downloads-url]

Node.js compression middleware with modern codings like brotli and zopfli.

The following compression codings are supported:

  - deflate
  - gzip
  - brotli
  - zopfli (for asynchronous compression of static assets)

In addition, if a response contains an ETag, `shrink-ray` will cache the compressed
result for later requests and even re-compress it asynchronously at the highest
possible compression (using zopfli for gzip and deflate and brotli quality 11
for brotli). This makes it possible to use the best possible compression
algorithms for static content without having to sacrifice runtime performance.

The combination of caching and use of better compression algorithms makes
`shrink-ray` serve static files in [our benchmark](./benchmark) 3x faster than
`compression` while using only one quarter as much CPU time.

**Note:** this project was forked from `compression`, the standard Express/Connect
compression middleware, and it stands on the shoulders of that impressive
project.

## Install

You must first install `node`, `npm`, and [the node native build
toolchain](https://github.com/nodejs/node-gyp#installation).

```bash
$ npm install shrink-ray
```

## API

```js
var shrinkRay = require('shrink-ray')
```

### shrinkRay([options])

Returns the shrink-ray middleware using the given `options`. The middleware
will attempt to compress response bodies for all request that traverse through
the middleware, based on the given `options`.

This middleware will never compress responses that include a `Cache-Control`
header with the [`no-transform` directive](https://tools.ietf.org/html/rfc7234#section-5.2.2.4),
as compressing will transform the body.

#### Options

`shrinkRay()` accepts these properties in the options object.

Note that `shrink-ray` options are backward-compatible with `compression`, but
we have also moved all of the gzip/deflate/zlib-specific parameters
into a sub-object called `zlib`. If you use `zlib` parameters at the root level
of options in `shrink-ray`, you will get a deprecation warning.

##### filter

A function to decide if the response should be considered for compression.
This function is called as `filter(req, res)` and is expected to return
`true` to consider the response for compression, or `false` to not compress
the response.

The default filter function uses the [compressible](https://www.npmjs.com/package/compressible)
module to determine if `res.getHeader('Content-Type')` is compressible.

##### cache

A function to decide if the compressed response should be cached for later use.
This function is called as `cache(req, res)` and is expected to return `true` if
the compressed response should be cached and `false` if the response should not
be cached. Note that `shrink-ray` uses ETags to ensure that a cache entry is appropriate
to return, so it will **never** cache a response that does not include an `ETag`,
even if the cache function returns `true`.

When a response is cached, it will be asynchronously re-encoded at the highest
quality level available for the compression algorithm in question (zopfli for
gzip and deflate, and brotli quality 11 for brotli). These quality levels are generally
not acceptable for use when responding to a request in real-time because they
are too CPU-intensive, but they can be performed in the background so that
subsequent requests get the highest compression levels available.

By default, `shrink-ray` caches any response that has an `ETag` header associated with
it, which means it should work out of the box with `express.static`, caching static
files with the highest available compression. If you serve a large number of dynamic
files with ETags, you may want to have your cache function restrict caching to your
static file directory so as to avoid thrashing the cache and wasting CPU time on
expensive compressions.

##### cacheSize

The approximate size, in bytes, of the cache. This is a number of bytes, any string
accepted by the [bytes](https://www.npmjs.com/package/bytes) module, or `false`
to indicate no caching. The default `cacheSize` is `128mb`.

The size includes space for the URL of the cached resources and the compressed bytes
of the responses. It does not, however, include overhead for JavaScript objects,
so the actual total amount of memory taken up by the cache will be somewhat larger
than `cacheSize` in practice.

When deciding how large to make your cache, remember that every cached resource
in your app may have as many as three compressed entries: one each for gzip,
deflate, and brotli.

##### threshold

The byte threshold for the response body size before compression is considered
for the response, defaults to `1kb`. This is a number of bytes, any string
accepted by the [bytes](https://www.npmjs.com/package/bytes) module, or `false`.

**Note** this is only an advisory setting; if the response size cannot be determined
at the time the response headers are written, then it is assumed the response is
_over_ the threshold. To guarantee the response size can be determined, be sure
set a `Content-Length` response header.

##### zlib

There is a sub-object of the options object called `zlib` which contains all of
the parameters related to `gzip` and `deflate`. In addition to
those listed below, [zlib](http://nodejs.org/api/zlib.html) options may be
passed in to the `zlib` sub-object.

Also note that to temporarily preserve backwards compatibility with `compression`,
all of these `zlib` parameters can be included at the root level of the options
object. However, having `zlib` parameters at the root level is deprecated, and we
plan to remove it.

##### zlib.chunkSize

The default value is `zlib.Z_DEFAULT_CHUNK`, or `16384`.

See [Node.js documentation](http://nodejs.org/api/zlib.html#zlib_memory_usage_tuning)
regarding the usage.

##### zlib.level

The level of zlib compression to apply to responses. A higher level will result
in better compression, but will take longer to complete. A lower level will
result in less compression, but will be much faster.

This is an integer in the range of `0` (no compression) to `9` (maximum
compression). The special value `-1` can be used to mean the "default
compression level", which is a default compromise between speed and
compression (currently equivalent to level 6).

  - `-1` Default compression level (also `zlib.Z_DEFAULT_COMPRESSION`).
  - `0` No compression (also `zlib.Z_NO_COMPRESSION`).
  - `1` Fastest compression (also `zlib.Z_BEST_SPEED`).
  - `2`
  - `3`
  - `4`
  - `5`
  - `6` (currently what `zlib.Z_DEFAULT_COMPRESSION` points to).
  - `7`
  - `8`
  - `9` Best compression (also `zlib.Z_BEST_COMPRESSION`).

The default value is `zlib.Z_DEFAULT_COMPRESSION`, or `-1`.

**Note** in the list above, `zlib` is from `zlib = require('zlib')`.

##### zlib.memLevel

This specifies how much memory should be allocated for the internal compression
state and is an integer in the range of `1` (minimum level) and `9` (maximum
level).

The default value is `zlib.Z_DEFAULT_MEMLEVEL`, or `8`.

See [Node.js documentation](http://nodejs.org/api/zlib.html#zlib_memory_usage_tuning)
regarding the usage.

##### zlib.strategy

This is used to tune the compression algorithm. This value only affects the
compression ratio, not the correctness of the compressed output, even if it
is not set appropriately.

  - `zlib.Z_DEFAULT_STRATEGY` Use for normal data.
  - `zlib.Z_FILTERED` Use for data produced by a filter (or predictor).
    Filtered data consists mostly of small values with a somewhat random
    distribution. In this case, the compression algorithm is tuned to
    compress them better. The effect is to force more Huffman coding and less
    string matching; it is somewhat intermediate between `zlib.Z_DEFAULT_STRATEGY`
    and `zlib.Z_HUFFMAN_ONLY`.
  - `zlib.Z_FIXED` Use to prevent the use of dynamic Huffman codes, allowing
    for a simpler decoder for special applications.
  - `zlib.Z_HUFFMAN_ONLY` Use to force Huffman encoding only (no string match).
  - `zlib.Z_RLE` Use to limit match distances to one (run-length encoding).
    This is designed to be almost as fast as `zlib.Z_HUFFMAN_ONLY`, but give
    better compression for PNG image data.

**Note** in the list above, `zlib` is from `zlib = require('zlib')`.

##### zlib.windowBits

The default value is `zlib.Z_DEFAULT_WINDOWBITS`, or `15`.

See [Node.js documentation](http://nodejs.org/api/zlib.html#zlib_memory_usage_tuning)
regarding the usage.

##### brotli

To control the parameters of the brotli algorithm, pass in child object at the key
`brotli` with one or more of the following brotli algorithm parameters: `lgblock`,
`lgwin`, `mode`, or `quality`.

Note that unlike the standard brotli library, which defaults to quality 11, this
library defaults to quality 4, which is [generally more appropriate for dynamic
content](https://blogs.akamai.com/2016/02/understanding-brotlis-potential.html).

#### .filter

The default `filter` function. This is used to construct a custom filter
function that is an extension of the default function.

```js
app.use(shrinkRay({filter: shouldCompress}))

function shouldCompress(req, res) {
  if (req.headers['x-no-compression']) {
    // don't compress responses with this request header
    return false
  }

  // fallback to standard filter function
  return shrinkRay.filter(req, res)
}
```

### res.flush

This module adds a `res.flush()` method to force the partially-compressed
response to be flushed to the client.

Note that brotli does not currently support `flush`, so it is a no-op when using
brotli compression.

## Examples

### express/connect

When using this module with express or connect, simply `app.use` the module as
high as you like. Requests that pass through the middleware will be compressed.

```js
var shrinkRay = require('shrink-ray')
var express = require('express')

var app = express()

// compress all requests
app.use(shrinkRay())

// add all routes
```

### Server-Sent Events

Because of the nature of compression this module does not work out of the box
with server-sent events. To compress content, a window of the output needs to
be buffered up in order to get good compression. Typically when using server-sent
events, there are certain block of data that need to reach the client.

You can achieve this by calling `res.flush()` when you need the data written to
actually make it to the client.

(Note that since brotli does not support `flush`, brotli will never be used as
compression for server-sent events.)

```js
var shrinkRay = require('shrink-ray')
var express     = require('express')

var app = express()

// compress responses
app.use(shrinkRay())

// server-sent event stream
app.get('/events', function (req, res) {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')

  // send a ping approx every 2 seconds
  var timer = setInterval(function () {
    res.write('data: ping\n\n')

    // !!! this is the important part
    res.flush()
  }, 2000)

  res.on('close', function () {
    clearInterval(timer)
  })
})
```

## License

[MIT](LICENSE)

[npm-image]: https://img.shields.io/npm/v/shrink-ray.svg
[npm-url]: https://npmjs.org/package/shrink-ray
[downloads-image]: https://img.shields.io/npm/dm/shrink-ray.svg
[downloads-url]: https://npmjs.org/package/shrink-ray
