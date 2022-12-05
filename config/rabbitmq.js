'use strict';

const config = require('config');
const helper = require('../plugins/helper');

const rabbitmqConfig = config.get('scheduler').rabbitmq;
const { protocol, username, password, host, port, exchange, vhost, connectOptions } = rabbitmqConfig;
const amqpURI = `${protocol}://${username}:${password}@${host}:${port}${vhost}`;
const schedulerMode = helper.convertToBool(config.get('scheduler').enabled);

/**
 * get configurations for rabbitmq
 * @method getConfig
 * @return {Object}
 */
function getConfig() {
    return {
        schedulerMode,
        amqpURI,
        exchange,
        connectOptions
    };
}

module.exports = { getConfig };
