'use strict';

const config = require('config');

/**
 * convert value to Boolean
 * @method convertToBool
 * @param {(Boolean|String)} value
 * @return {Boolean}
 */
function convertToBool(value) {
    if (typeof value === 'boolean') {
        return value;
    }

    // trueList refers to https://yaml.org/type/bool.html
    const trueList = ['on', 'true', 'yes', 'y'];
    const lowerValue = String(value).toLowerCase();

    return trueList.includes(lowerValue);
}

const rabbitmqConfig = config.get('scheduler').rabbitmq;
const { protocol, username, password, host, port, exchange, vhost, connectOptions } = rabbitmqConfig;
const amqpURI = `${protocol}://${username}:${password}@${host}:${port}${vhost}`;
const schedulerMode = convertToBool(config.get('scheduler').enabled);

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
