// development config
var path = require('path');
var MiniCssExtractPlugin = require('mini-css-extract-plugin');

module.exports = {
  mode: 'development',
  devtool: 'eval-source-map',

  entry: './src/main',

  output: {
    path: path.join(__dirname, 'build'),
    filename: 'app.js',
    publicPath: '/'
  },

  module: {
    rules: [{
      test: /\.jsx?$/,
      include: path.join(__dirname, 'src'),
      use: 'babel-loader'
    }, {
      test: /\.less$/,
      use: [MiniCssExtractPlugin.loader, 'css-loader', 'less-loader']
    }, {
      test: /\.(woff2?|eot|ttf|svg)$/,
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
