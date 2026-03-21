module.exports = combineOptions;

function combineOptions(options) {
  options = options || Object.create(null);

  var clearColor = options.clearColor;
  if (typeof clearColor === 'string') {
    clearColor = parseInt(clearColor.replace(/^#/, ''), 16);
  }

  /**
   * Background of the scene in hexadecimal form. Default value is 0x000000 (black);
   */
  options.clearColor = typeof clearColor === 'number' ? clearColor : 0x000000;

  return options;
}
