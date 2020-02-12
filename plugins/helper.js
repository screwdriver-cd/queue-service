'use strict';

const request = require('request');
const requestretry = require('requestretry');
const { queuePrefix } = require('../config/redis');
const RETRY_LIMIT = 3;
const RETRY_DELAY = 5;

/**
 * Update build status
 * @method updateBuildStatus
 * @param  {Object}  updateConfig build config of the job
 * @return {Object}  err Callback with err object
 */
function updateBuildStatus(updateConfig) {
    const { redisInstance, status, statusMessage, buildId } = updateConfig;

    const buildConfig = await redisInstance.hget(`${queuePrefix}buildConfigs`, buildId)
        .then(JSON.parse);

    if (!buildConfig) return null;

    return new Promise((resolve, reject) => {
        request({
            json: true,
            method: 'PUT',
            uri: `${fullBuildConfig.apiUri}/v4/builds/${buildId}`,
            body: {
                status,
                statusMessage
            },
            auth: {
                bearer: fullBuildConfig.token
            }
        }, (err, res) => {
            if (!err && res.statusCode === 200) {
                return resolve(res.body);
            }

            return reject(err);
        });
    });
}

/**
 * Updates the step with code and end time
 * @method updateStepStop
 * @param {Object} stepConfig
 * @param {Object} stepConfig.redisInstance
 * @param {String} stepConfig.buildId
 * @param {String} stepConfig.stepName
 * @param {Integer} stepConfig.code
 * @return {Promise} response body or error
 */
async function updateStepStop(stepConfig) {
    const { redisInstance, buildId, stepName, code } = stepConfig;
    const buildConfig = await redisInstance.hget(`${queuePrefix}buildConfigs`, buildId)
        .then(JSON.parse);

    // if buildConfig got deleted already, do not update
    if (!buildConfig) return null;

    return new Promise((resolve, reject) => {
        request({
            json: true,
            method: 'PUT',
            uri: `${buildConfig.apiUri}/v4/builds/${buildId}/steps/${stepName}`,
            body: {
                endTime: new Date().toISOString(),
                code
            },
            auth: {
                bearer: buildConfig.token
            }
        }, (err, res) => {
            if (!err && res.statusCode === 200) {
                return resolve(res.body);
            }

            return reject(err);
        });
    });
}

/**
 * Gets the current active step in the build
* @method getCurrentStep
 * @param {Object} config
 * @param {Object} config.redisInstance
 * @param {String} config.buildId
 * @return {Promise} active step or error
 */
async function getCurrentStep(config) {
    const { redisInstance, buildId } = config;
    const buildConfig = await redisInstance.hget(`${queuePrefix}buildConfigs`, buildId)
        .then(JSON.parse);

    // if buildConfig got deleted already, do not update
    if (!buildConfig) return null;

    return new Promise((resolve, reject) => {
        request({
            json: true,
            method: 'GET',
            uri: `${buildConfig.apiUri}/v4/builds/${buildId}/steps?status=active`,
            auth: {
                bearer: buildConfig.token
            }
        }, (err, res) => {
            if (!err && res.statusCode === 200) {
                if (res.body && res.body.length > 0) {
                    return resolve(res.body[0]);
                }

                return resolve(null);
            }

            return reject(err);
        });
    });
}

/**
 * 
 * @param {String} apiUri 
 * @param {Object} config 
 * @param {Object} buildEvent 
 * @param {Function} retryStrategyFn 
 */
async function createBuildEvent(apiUri, config, buildEvent, retryStrategyFn) {
    const { redisInstance, buildId } = config;
    const buildConfig = await redisInstance.hget(`${queuePrefix}buildConfigs`, buildId)
        .then(JSON.parse);
    return new Promise((resolve, reject) => {
        requestretry({
            json: true,
            method: 'POST',
            uri: `${apiUri}/v4/events`,
            headers: {
                Authorization: `Bearer ${buildConfig.token}`,
                'Content-Type': 'application/json'
            },
            body: buildEvent,
            maxAttempts: RETRY_LIMIT,
            retryDelay: RETRY_DELAY * 1000, // in ms
            retryStrategy: retryStrategyFn
        }, (err, res) => {
            if (!err && res.statusCode === 201) {
                return resolve(res);
            }
            if (res.statusCode !== 201) {
                return reject(JSON.stringify(res.body));
            }

            return reject(err);
        });
    });
}

/**
 * 
 * @param {String} apiUri 
 * @param {String} pipelineId 
 * @param {Function} retryStrategyFn 
 */
async function getPipelineAdmin(apiUri, pipelineId, retryStrategyFn) {
    const { redisInstance, buildId } = config;
    const buildConfig = await redisInstance.hget(`${queuePrefix}buildConfigs`, buildId)
        .then(JSON.parse);
    return new Promise((resolve, reject) => {
        requestretry({
            json: true,
            method: 'GET',
            uri: `${apiUri}/pipelines/${pipelineId}/admin`,
            headers: {
                Authorization: `Bearer ${buildConfig.token}`,
                'Content-Type': 'application/json'
            },
            body: buildEvent,
            maxAttempts: RETRY_LIMIT,
            retryDelay: RETRY_DELAY * 1000, // in ms
            retryStrategy: retryStrategyFn
        }, (err, res) => {
            if (!err && res.statusCode === 201) {
                return resolve(res);
            }
            if (res.statusCode !== 201) {
                return reject(JSON.stringify(res.body));
            }

            return reject(err);
        });
    });
}

/**
 * 
 * @param {String} buildId
 * @param {String} token
 * @param {String} status
 * @param {String} statusMessage 
 * @param {String} apiUri 
 * @param {Object} updateConfig 
 */
async function updateBuildStatusWithRetry(updateConfig) {
    const { buildId, token, status, statusMessage, apiUri } = updateConfig;
    // const buildConfig = await redisInstance.hget(`${queuePrefix}buildConfigs`, buildId)
    //     .then(JSON.parse);

    // if (!buildConfig) return null;

    const options = {
        json: true,
        method: 'PUT',
        uri: `${apiUri}/v4/builds/${buildId}`,
        body: {
            status,
            statusMessage
        },
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        maxAttempts: RETRY_LIMIT,
        retryDelay: RETRY_DELAY * 1000, // in ms
        retryStrategy: this.requestRetryStrategy
    };

    return new Promise((resolve, reject) => {
        requestretry(options, (err, response) => {
            if (!err && response.statusCode === 200) {
                return resolve(response);
            }

            if (response.statusCode !== 200) {
                return reject(JSON.stringify(response.body));
            }

            return reject(err);
        });
    });
}

export default {
    updateBuildStatus,
    updateStepStop,
    getCurrentStep,
    createBuildEvent,
    getPipelineAdmin,
    updateBuildStatusWithRetry
};
