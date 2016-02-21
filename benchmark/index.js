var express = require('express')
var http = require('http')
var yargs = require('yargs')

var args = yargs(process.argv)
	.usage('Usage: $0 [options]')
	.option("c", {
		default: "compression",
		choices: ["compression", "shrink-ray", "none"],
		describe: "The compression middleware to use (compression or shrink-ray)",
	})
	.help('?')
	.alias('?', 'help')
	.argv

var app = express();

if (args.c !== "none") app.use(require(args.c)())
app.use(express.static('canterbury'))

var server = http.createServer(app)
server.listen(3000, function () {
  console.log('Compressed Canterbury corpus app listening on port 3000 with ' + args.c + ' middleware!')
})
