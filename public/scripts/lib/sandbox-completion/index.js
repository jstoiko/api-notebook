var _          = require('underscore');
var middleware = require('../../state/middleware');
var isInScope  = require('../codemirror/is-in-scope');
var fromPath   = require('../from-path');

/**
 * Sanitize a definition object into our regular format.
 *
 * @param  {Object} definition
 * @return {Object}
 */
var sanitizeDefinition = function (description) {
  _.each(description, function (describe, key) {
    // Skip over definition keys.
    if (!_.isObject(describe) || key.charAt(0) === '!') { return; }

    // Sanitize functions into their parts.
    if (/^fn\(/.test(describe['!type'])) {
      var fnParts    = describe['!type'].split(' -> ');
      var returnType = fnParts.length > 1 ? fnParts.pop() : null;
      var fnType     = fnParts.join(' -> ');

      describe['!type']   = fnType;
      describe['!return'] = returnType;
    }

    return sanitizeDefinition(describe);
  });

  return description;
};

/**
 * JavaScript description documents from Tern.js.
 *
 * @type {Array}
 */
var DESCRIPTIONS = _.map([
  require('./browser.json'),
  require('./ecma5.json')
], sanitizeDefinition);

/**
 * Recurse through the description structure and attach descriptions to nodes
 * using a `Map` interface.
 *
 * @param  {Map}    map
 * @param  {Object} describe
 * @param  {Object} global
 * @return {Map}
 */
var attachDescriptions = function (map, describe, global) {
  (function recurse (definition, context) {
    // Break recursion on a non-object.
    if (!_.isObject(context) || !_.isObject(definition)) { return; }

    // Set the map object reference to point to the description.
    map.set(context, definition);

    // Iterate over the definition object and attach more definitions.
    _.each(definition, function (describe, key) {
      // Definitions are prepended with an exclamation mark.
      if (key.charAt(0) === '!') { return; }

      // We need to use property descriptors here since Firefox throws errors
      // with getters on some prototype properties.
      var descriptor = Object.getOwnPropertyDescriptor(context, key);

      return descriptor && recurse(describe, descriptor.value);
    });
  })(describe, global);

  return map;
};

/**
 * Accepts a window object and returns an object for use with middleware.
 *
 * @param  {Object} sandbox
 * @return {Object}
 */
module.exports = function (global) {
  var map     = new Map();
  var plugins = {};

  // Iterate over the description documents and attach.
  _.each(DESCRIPTIONS, function (description) {
    attachDescriptions(map, description, global);
  });

  /**
   * Middleware plugin for describing native types.
   *
   * @param {Object}   data
   * @param {Function} next
   * @param {Function} done
   */
  plugins['completion:describe'] = function (data, next, done) {
    var token = data.token;
    var description;

    // Avoiding describing function arguments and variables.
    if (token.type === 'variable' && isInScope(token, token.string)) {
      return next();
    }

    if (_.isObject(data.context)) {
      description = map.get(data.context);
    }

    if (!description) {
      var obj     = data.parent;
      var objDesc = map.get(obj);
      var type;

      while (obj) {
        objDesc = map.get(obj);

        if (objDesc) {
          if ((type = objDesc['!type']) && type.charAt(0) === '+') {
            obj = fromPath(data.window, type.substr(1).split('.')).prototype;
            objDesc = map.get(obj);
          }

          if (objDesc[token.string]) {
            description = objDesc[token.string];
            break;
          }
        }

        obj = data.window.Object.getPrototypeOf(obj);
      }
    }

    // If we didn't retrieve a description, allow the next function to run.
    if (description == null) {
      return next();
    }

    return done(null, description);
  };

  /**
   * Middleware for looking up function return types for native functions.
   *
   * @param {Object}   data
   * @param {Function} next
   * @param {Function} done
   */
  plugins['completion:function'] = function (data, next, done) {
    var constructors = [
      data.window.Array,
      data.window.String,
      data.window.Boolean
    ];

    // Constructor functions are relatively easy to handle.
    if (data.isConstructor || _.contains(constructors, data.context)) {
      return done(null, data.context.prototype);
    }

    // This may be a little dodgy, but as long as someone hasn't extended the
    // native prototype object with something that has side-effects, we'll be
    // fine.
    if (!_.isObject(data.parent)) {
      return done(null, data.context.call(data.parent));
    }

    // Use the documentation to detect the return types.
    middleware.trigger('completion:describe', data, function (err, describe) {
      var returnType = describe && describe['!return'];

      // Check for an error and ensure we have a return description.
      if (err || !/^fn\(/.test(describe['!type']) || !returnType) {
        return next(err);
      }

      if (returnType === 'string') {
        return done(null, data.window.String());
      }

      if (returnType === 'number') {
        return done(null, data.window.Number());
      }

      if (returnType === 'bool') {
        return done(null, data.window.Boolean());
      }

      if (/\[.*\]/.test(returnType)) {
        return done(null, data.window.Array());
      }

      if (returnType === 'fn()') {
        return done(null, data.window.Function());
      }

      // Returns its own instance.
      if (returnType === '!this') {
        return done(null, data.parent);
      }

      // Instance type return.
      if (_.isString(returnType) && returnType.charAt(0) === '+') {
        var path        = returnType.substr(1).split('.');
        var constructor = fromPath(data.window, path);

        if (_.isFunction(constructor)) {
          return done(null, constructor.prototype);
        }
      }

      return next();
    }, true);
  };

  return plugins;
};
