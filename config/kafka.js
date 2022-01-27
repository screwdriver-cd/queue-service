'use strict';

const config = require('config');
const kafkaConfig = config.get('kafka');

/**
 * get config
 * @returns Object containing kafka config values
 */
function get() {
    return {
        kafkaEnabled: kafkaConfig.enabled === 'true',
        useShortRegionName: kafkaConfig.shortRegion === 'true',
        kafkaPrefix: kafkaConfig.prefix
    };
}

module.exports = {
    get
};
