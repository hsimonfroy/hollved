// production config
var path = require('path');
var MiniCssExtractPlugin = require('mini-css-extract-plugin');

module.exports = {
  mode: 'production',

  entry: './src/main',

  output: {
    path: path.join(__dirname, 'build'),
    filename: 'app.js'
  },

  module: {
    rules: [{
      test: /\.jsx?$/,
      exclude: /node_modules/,
      use: 'babel-loader'
    }, {
      test: /\.less$/,
      use: [MiniCssExtractPlugin.loader, 'css-loader', 'less-loader']
    }, {
      test: /\.(woff2?|eot|ttf|otf|svg)$/,
      type: 'asset/resource'
    }]
  },

  plugins: [
    new MiniCssExtractPlugin({ filename: 'styles.css' })
  ],

  resolve: {
    extensions: ['.js', '.jsx']
  }
};
