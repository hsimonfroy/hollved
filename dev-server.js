var devConfig = require('./webpack.local.config');

ensureBuildExists();

var port = parseInt(process.env.PORT, 10) || 8082;

var webpack = require('webpack');
var WebpackDevServer = require('webpack-dev-server');
var compiler = webpack(devConfig);

// WebpackDevServer v5: options first, compiler second
var server = new WebpackDevServer({
  port: port,
  host: '0.0.0.0',
  static: './build',
  hot: true,
  historyApiFallback: true,
  allowedHosts: 'all'
}, compiler);

server.start().then(function() {
  console.log('Dev Server listening at http://127.0.0.1:' + port);
}).catch(function(err) {
  console.log(err);
});

function ensureBuildExists() {
  var fs = require('fs');
  var path = require('path');
  var buildDir = path.join(__dirname, 'build');

  if (!fs.existsSync(buildDir)) {
    fs.mkdirSync(buildDir);
  }

  var source = path.join(__dirname, 'src', 'index.html');
  var dest = path.join(__dirname, 'build', 'index.html');

  console.log('Copying ' + source + ' to ' + dest);
  fs.createReadStream(source).pipe(fs.createWriteStream(dest));
}
