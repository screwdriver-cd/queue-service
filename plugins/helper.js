'use strict';

const request = require('request');
const requestretry = require('requestretry');
const { queuePrefix } = require('../config/redis');
const RETRY_LIMIT = 3;
const RETRY_DELAY = 5;

/**
 *
 * @param {String} method
 * @param {String} uri
 * @param {String} token
 * @param {Function} retryStrategyFn
 * @param {Object} body
 */
function formatOptions(method, uri, token, body, retryStrategyFn) {
    const options = {
        json: true,
        method,
        uri,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
        }
    };

    if (body) {
        Object.assign(options, { body });
    }
    if (retryStrategyFn) {
        Object.assign(options, {
            retryStrategy: retryStrategyFn,
            maxAttempts: RETRY_LIMIT,
            retryDelay: RETRY_DELAY * 1000 // in ms
        });
    }

    return options;
}

/**
 * Update build status
 * @method updateBuildStatus
 * @param  {Object}  updateConfig build config of the job
 * @return {Object}  err Callback with err object
 */
async function updateBuildStatus(updateConfig) {
    const { redisInstance, status, statusMessage, buildId } = updateConfig;

    const buildConfig = await redisInstance.hget(`${queuePrefix}buildConfigs`, buildId)
        .then(JSON.parse);

    if (!buildConfig) return null;

    return new Promise((resolve, reject) => {
        request(formatOptions(
            'PUT',
            `${buildConfig.apiUri}/v4/builds/${buildId}`,
            buildConfig.token,
            {
                status,
                statusMessage
            }), (err, res) => {
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
        request(formatOptions(
            'PUT',
            `${buildConfig.apiUri}/v4/builds/${buildId}/steps/${stepName}`,
            buildConfig.token,
            {
                endTime: new Date().toISOString(),
                code
            }
        ), (err, res) => {
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
 * @param {Object} stepConfig
 * @param {Object} stepConfig.redisInstance
 * @param {String} stepConfig.buildId
 * @return {Promise} active step or error
 */
async function getCurrentStep(stepConfig) {
    const { redisInstance, buildId } = stepConfig;
    const buildConfig = await redisInstance.hget(`${queuePrefix}buildConfigs`, buildId)
        .then(JSON.parse);

    // if buildConfig got deleted already, do not update
    if (!buildConfig) return null;

    return new Promise((resolve, reject) => {
        request(formatOptions(
            'GET',
            `${buildConfig.apiUri}/v4/builds/${buildId}/steps?status=active`,
            buildConfig.token
        ), (err, res) => {
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
 * @param {Object} eventConfig
 * @param {Object} buildEvent
 * @param {Function} retryStrategyFn
 */
async function createBuildEvent(apiUri, eventConfig, buildEvent, retryStrategyFn) {
    const { redisInstance, buildId, eventId } = eventConfig;
    const buildConfig = await redisInstance.hget(`${queuePrefix}buildConfigs`, buildId)
        .then(JSON.parse);
    const body = Object.assign({}, buildEvent, { buildId, parentEventId: eventId });

    return new Promise((resolve, reject) => {
        requestretry(formatOptions(
            'POST',
            `${apiUri}/v4/events`,
            buildConfig.token,
            body,
            retryStrategyFn
        ), (err, res) => {
            if (!err) {
                if (res.statusCode === 201) {
                    return resolve(res);
                }
                if (res.statusCode !== 201) {
                    return reject(JSON.stringify(res.body));
                }
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
async function getPipelineAdmin(requestConfig, apiUri, pipelineId, retryStrategyFn) {
    const { redisInstance, buildId } = requestConfig;
    const buildConfig = await redisInstance.hget(`${queuePrefix}buildConfigs`, buildId)
        .then(JSON.parse);

    return new Promise((resolve, reject) => {
        requestretry(formatOptions(
            'GET',
            `${apiUri}/pipelines/${pipelineId}/admin`,
            buildConfig.token,
            undefined,
            retryStrategyFn
        ), (err, res) => {
            if (!err) {
                if (res.statusCode === 200) {
                    return resolve(res.body);
                }
                if (res.statusCode !== 200) {
                    return null;
                }
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
async function updateBuildStatusWithRetry(updateConfig, retryStrategyFn) {
    const { buildId, token, status, statusMessage, apiUri } = updateConfig;

    return new Promise((resolve, reject) => {
        requestretry(formatOptions(
            'PUT',
            `${apiUri}/v4/builds/${buildId}`,
            token,
            { statusMessage, status },
            retryStrategyFn
        ), (err, res) => {
            if (!err) {
                if (res.statusCode === 201) {
                    return resolve(res);
                }

                if (res.statusCode !== 201) {
                    return null;
                }
            }

            return reject(err);
        });
    });
}

module.exports = {
    updateBuildStatus,
    updateStepStop,
    getCurrentStep,
    createBuildEvent,
    getPipelineAdmin,
    updateBuildStatusWithRetry
};
