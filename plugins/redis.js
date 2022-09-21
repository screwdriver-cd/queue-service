'use strict';

const Redis = require('ioredis');
const logger = require('screwdriver-logger');
const { connectionDetails } = require('../config/redis');

let redis;

if (connectionDetails.hosts) {
    redis = new Redis.Cluster(
            connectionDetails.hosts, {
            redisOptions: {
                password: connectionDetails.options.password,
                tls: connectionDetails.options.tls,
                clusterRetryStrategy: connectionDetails.options.clusterRetryStrategy,
                showFriendlyErrorStack: true
            },
            slotsRefreshTimeout: connectionDetails.slotsRefreshTimeout
        }
    );
} else {
    redis = new Redis({
        port: connectionDetails.port,
        host: connectionDetails.host,
        password: connectionDetails.options.password,
        tls: connectionDetails.options.tls
    });
}

redis.on('connecting', () => {
    logger.info('Connecting to Redis.');
});
redis.on('connect', () => {
    logger.info('Successfully connected to Redis');
});
redis.on('error', err => {
    if (err.code === 'ECONNREFUSED') {
        logger.error(`Could not connect to Redis: ${err.message}.`);
    } else {
        logger.error(`Redis encountered an error: ${err.message}.`);
        throw err;
    }
});

module.exports = redis;
