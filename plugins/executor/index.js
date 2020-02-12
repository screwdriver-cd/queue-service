'use strict';
const putRoute = require('./put');
const deleteRoute = require('./delete');

module.exports = async function register(server, options, next) {
    server.route([
        putRoute(),
        deleteRoute()
    ])
    await next();
}

exports.register.attributes = {
    name: 'executor'
};
