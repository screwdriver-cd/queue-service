'use strict';
const schedulerRoute = require('./scheduler');

module.exports = async function register(server, options, next) {
    server.route([
        schedulerRoute()
    ])
    await next();
}

exports.register.attributes = {
    name: 'worker'
};
