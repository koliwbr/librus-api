"use strict";

const requestprom = require("request-promise")
    , cheerio = require("cheerio").default
    , _       = require("lodash")
    , request = require("request");

const config = require("./config.js");

/** Export class */
class Librus {
  /**
   * Cretae Librus API client
   * @param cookies  Array of cookies
   */
  constructor(cookies) {
    this.cookie = requestprom.jar();

    /**
     * Get cookies from array
     * TODO: Refactor
     */
    this.cookie.setCookie(requestprom.cookie("TestCookie=1;"), config.page_url);
    _.each(cookies, val => {
      this.cookie.setCookie(requestprom.cookie(`${val.key}=${val.value}`), config.page_url);
    });

    this.caller = {
        'get': _.bind(this._request, this, "get")
      , 'post': _.bind(this._request, this, "post")
    };
    this._loadModules([
        "inbox"
      , "homework"
      , "absence"
      , "calendar"
      , "info"
    ]);

    /**
     * Wraps _mapper function and get only one result
     * from call's return
     */
    this._singleMapper = _.wrap(this._mapper, function(func) {
      return func.apply(this, _.drop(arguments)).then(array => {
        return array.length && array[0];
      });
    });

    /**
     * Two column table map
     * @param apiFunction Librus API method
     * @param cssPath     CSS Path to parsed element
     * @param array       Keys
     * @returns {Promise}
     */
    this._tableMapper = _.wrap(this._singleMapper, function(func) {
      let keys = _.last(arguments)
        , args = _.chain(arguments);

      /** Get arguments list */
      let val = args
        /** remove first and last */
        .remove((val, index) => {
          return index && index !== arguments.length - 1;
        })

        /** add parser callback */
        .concat([
          ($, table) => { return Librus.mapTableValues(table, keys); }
        ])
        .value();

      /** call _singleMapper */
      return func.apply(this, val)
    });
  }

  /**
   * Load list of modules to app
   * @param modules Modules list
   * @private
   */
  _loadModules(modules) {
    _.each(modules, name => {
      let module = require(`./resources/${name}.js`);
      this[name] = new module(this);
    });
  }

  /**
   * Authorize to Librus
   * @param login User login
   * @param pass  User password
   * @returns {Promise}
   */
  authorize(login, pass) {
    let caller = this.caller;
    return caller
      .get("https://api.librus.pl/OAuth/Authorization?client_id=46&response_type=code&scope=mydata")
      .then(response => {
          return caller
            .post("https://api.librus.pl/OAuth/Authorization?client_id=46", {
              form: {
                  'action': "login",
                  'login': login,
                  "pass": pass
              }})})
      .then(response => {
        return caller
         .get("https://api.librus.pl/OAuth/Authorization/2FA?client_id=46")
         .then(response => {
            return this.cookie.getCookies(config.page_url);
          })
      })
      .catch(err => console.log);
}

  /**
   * Make request to server
   * @param method        REST method
   * @param apiFunction   Librus API method
   * @param data          Form data
   * @param blank         Return blank message
   * @returns {Promise}
   * @private
   */
  _request(method, apiFunction, data, blank) {
    let postData = _.extend({
           jar: this.cookie
         , gzip: true
         , headers: {
           'User-Agent': "User-Agent:Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/47.0.2526.73 Safari/537.36"
         }
       }, data);

       /** Make request */
       let target = apiFunction.startsWith("https://") ? apiFunction : config.page_url + "/" + apiFunction;
       return requestprom[method](target, postData)
         .then(response =>
           cheerio.load(response)
         );

  }

  /**
   * Download a message attachment
   * @param path   Path to the file as specified on the message view (wiadomosci/pobierz_zalacznik/<message id>/<file id>)
   * @returns {String}
   */
  _getFile(path) {
    let target = path.startsWith("https://") ? path : config.page_url + "/" + path;

    let options1 = {
      jar: this.cookie,
      gzip: true,
      headers: {
        'User-Agent': "User-Agent:Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/47.0.2526.73 Safari/537.36"
      }
    };

    let options2 = _.extend({
      uri: target,
      followRedirect: false,
      simple: false,
      resolveWithFullResponse: true,
    }, options1);

    /** Make request */
    return requestprom['get'](options2).then(response => {
      let redirect = response.headers.location, url = null;
      // For some reason files may be served in two totally different ways...
      if (redirect.includes("GetFile")) {
        url = redirect + "/get";
        return request.get(url, options1);
      }
      else {
        const key = new URL(redirect).searchParams.get("singleUseKey");
        return this._waitForFileReady(key, options1, redirect);
      }
    });
  }

  /**
   * Wait for a file to be ready and download it
   * @param key        Single use file key
   * @param options    Request options
   * @param redirect   Download attempt URL
   * @returns {String}
   */
  _waitForFileReady(key, options, redirect) {
    const checkKey = "https://sandbox.librus.pl/index.php?action=CSCheckKey";
    return requestprom['post'](_.extend({
      url: checkKey,
      form: {
        singleUseKey: key
      },
    }, options)).then(response => {
      if (response.includes("ready")) {
        let url = redirect.replace("CSTryToDownload", "CSDownload");
        return request.get(url, options);
      }
      else {
        return this._waitForFileReady(key, options, redirect);
      }
    });
  }

  /**
   * Map array values to array using parser
   * @param $       Document
   * @param parser  Parser callback
   * @param cssPath CSS path to DOM element
   * @returns {Array}
   */
  static arrayMapper($, parser, cssPath) {
    return _.compact(_.map($(cssPath), _.partial(parser, $)));
  }

  /**
   * Parse request and map output data to array
   * @param apiFunction Librus API method
   * @param cssPath     CSS Path to parsed element
   * @param parser      Parser callback
   * @param method      REST method
   * @param data        Form data
   * @returns {Promise}
   * @private
   */
  _mapper(apiFunction, cssPath, parser, method, data) {
    return this
      ._request(method || "get", apiFunction, data)
      .then($ => {
        return Librus.arrayMapper($, parser, cssPath);
      });
  }

  /**
   * Map two columns forms values
   * @param table   Table DOM
   * @param keys    Table keys
   * @returns {Array}
   * @example
   *
   * <tr><td>Id:</td><td>23</td></tr>
   * <tr><td>Name:</td><td>test</td></tr>
   *
   * mapTableValues(dom, ["id", "name"])
   * // => { id: 23, name: "test" }
   */
   static mapTableValues(table, keys) {
    return _.zipObject(
      keys, _.map(cheerio(table).find("tr td:nth-child(2)"), row => {
        return cheerio(row).trim();
      })
    );
  }

  /**
   * Parse key => value table to javascript assoc
   * @param table DOM table
   * @returns {Array}
   */
  static tableValues(table) {
    return _
      .chain()
      .map(cheerio(table).find("tr"), row => {
        return [
            cheerio(row).children(0).trim()
          , cheerio(row).children(1).trim()
        ];
      })
      .zipObject()
      .value();
  }
}

/** Export */
module.exports = Librus;
