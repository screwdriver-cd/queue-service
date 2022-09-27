'use strict';

const Redis = require('ioredis');
const logger = require('screwdriver-logger');
const { connectionDetails } = require('../config/redis');

let redis;

if (connectionDetails.redisClusterHosts) {
    redis = new Redis.Cluster(connectionDetails.redisClusterHosts, {
        redisOptions: connectionDetails.redisOptions,
        slotsRefreshTimeout: connectionDetails.slotsRefreshTimeout,
        clusterRetryStrategy: () => 100
    });
} else {
    redis = new Redis(connectionDetails.redisOptions);
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
