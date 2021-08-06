'use strict';

const request = require('screwdriver-request');
const logger = require('screwdriver-logger');
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
function formatOptions(caller, method, url, token, json, retryStrategyFn) {
    const options = {
        method,
        url,
        headers: {
            Authorization: `Bearer ${token}`
        }
    };

    if (json) {
        Object.assign(options, { json });
    }
    if (retryStrategyFn) {
        const retryOptions = {
            limit: RETRY_LIMIT,
            calculateDelay: ({ computedValue }) => (computedValue ? RETRY_DELAY * 1000 : 0) // in ms
        };

        if (method === 'POST') {
            Object.assign(retryOptions, {
                methods: ['POST']
            });
        }

        Object.assign(options, {
            retryOptions,
            hooks: {
                afterResponse: [retryStrategyFn]
            }
        });
    }
    if (caller) {
        Object.assign(options, {
            context: {
                caller
            }
        });
    }

    logger.info(`${options.method} ${options.uri}`);

    return options;
}

/**
 * Update build status
 * @method updateBuildStatus
 * @param  {Object}  updateConfig build config of the job
 * @return {Promise}
 */
async function updateBuildStatus(updateConfig) {
    const { redisInstance, status, statusMessage, buildId } = updateConfig;

    const buildConfig = await redisInstance.hget(`${queuePrefix}buildConfigs`, buildId).then(JSON.parse);

    if (!buildConfig) return null;

    return new Promise((resolve, reject) => {
        request(
            formatOptions('updateBuildStatus', 'PUT', `${buildConfig.apiUri}/v4/builds/${buildId}`, buildConfig.token, {
                status,
                statusMessage
            }),
            (err, res) => {
                if (!err) {
                    if (res.statusCode === 200) {
                        return resolve(res.body);
                    }
                    logger.error(`PUT /v4/builds/${buildId} returned non 200, ${res.statusCode}, ${res.body}`);

                    return reject(new Error(`Failed to updateBuildStatus with ${res.statusCode} code and ${res.body}`));
                }

                return reject(err);
            }
        );
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
    const buildConfig = await redisInstance.hget(`${queuePrefix}buildConfigs`, buildId).then(JSON.parse);

    // if buildConfig got deleted already, do not update
    if (!buildConfig) return null;

    return new Promise((resolve, reject) => {
        request(
            formatOptions(
                'updateStepStop',
                'PUT',
                `${buildConfig.apiUri}/v4/builds/${buildId}/steps/${stepName}`,
                buildConfig.token,
                {
                    endTime: new Date().toISOString(),
                    code
                }
            ),
            (err, res) => {
                if (!err && res.statusCode === 200) {
                    return resolve(res.body);
                }

                return reject(err);
            }
        );
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
    const buildConfig = await redisInstance.hget(`${queuePrefix}buildConfigs`, buildId).then(JSON.parse);

    // if buildConfig got deleted already, do not update
    if (!buildConfig) return null;

    return new Promise((resolve, reject) => {
        request(
            formatOptions(
                'getCurrentStep',
                'GET',
                `${buildConfig.apiUri}/v4/builds/${buildId}/steps?status=active`,
                buildConfig.token
            ),
            (err, res) => {
                if (!err && res.statusCode === 200) {
                    if (res.body && res.body.length > 0) {
                        return resolve(res.body[0]);
                    }

                    return resolve(null);
                }

                return reject(err);
            }
        );
    });
}

/**
 *
 * @param {String} apiUri
 * @param {Object} eventConfig
 * @param {Object} buildEvent
 * @param {Function} retryStrategyFn
 */
async function createBuildEvent(apiUri, token, buildEvent, retryStrategyFn) {
    return new Promise((resolve, reject) => {
        request(
            formatOptions('createBuildEvent', 'POST', `${apiUri}/v4/events`, token, buildEvent, retryStrategyFn),
            (err, res) => {
                if (!err) {
                    logger.info(
                        `POST /v4/events/${buildEvent.buildId} completed with attempts, ${res.statusCode}, ${res.attempts}`
                    );
                    if (res.statusCode === 201) {
                        return resolve(res);
                    }
                    logger.info(
                        `POST /v4/events/${buildEvent.buildId} returned non 201, ${res.statusCode}, ${JSON.stringify(
                            res.body
                        )}`
                    );

                    return res.statusCode === 200
                        ? resolve(JSON.stringify(res.body))
                        : reject(JSON.stringify(res.body));
                }

                return reject(err);
            }
        );
    });
}

/**
 *
 * @param {String} apiUri
 * @param {String} pipelineId
 * @param {Function} retryStrategyFn
 */
async function getPipelineAdmin(token, apiUri, pipelineId, retryStrategyFn) {
    return new Promise((resolve, reject) => {
        request(
            formatOptions(
                'getPipelineAdmin',
                'GET',
                `${apiUri}/v4/pipelines/${pipelineId}/admin`,
                token,
                undefined,
                retryStrategyFn
            ),
            (err, res) => {
                if (!err) {
                    logger.info(
                        `POST /v4/pipelines/${pipelineId}/admin completed with attempts, ${res.statusCode}, ${res.attempts}`
                    );
                    if (res.statusCode === 200) {
                        return resolve(res.body);
                    }
                    if (res.statusCode !== 200) {
                        return reject(
                            new Error(
                                `No pipeline admin found with ${res.statusCode} code and ${JSON.stringify(res.body)}`
                            )
                        );
                    }
                }

                return reject(err);
            }
        );
    });
}

/**
 *
 * @param {String} buildId
 * @param {String} token
 * @param {Object} payload
 * @param {String} apiUri
 * @param {Object} updateConfig
 */
async function updateBuild(updateConfig, retryStrategyFn) {
    const { buildId, token, payload, apiUri } = updateConfig;

    return new Promise((resolve, reject) => {
        request(
            formatOptions('updateBuild', 'PUT', `${apiUri}/v4/builds/${buildId}`, token, payload, retryStrategyFn),
            (err, res) => {
                if (!err) {
                    logger.info(
                        `PUT /v4/builds/${buildId} completed with attempts, ${res.statusCode}, ${res.attempts}`
                    );
                    if (res.statusCode === 200) {
                        return resolve(res.body);
                    }

                    if (res.statusCode !== 200) {
                        return reject(
                            new Error(`Build not updated with ${res.statusCode}code and ${JSON.stringify(res.body)}`)
                        );
                    }
                }

                return reject(err);
            }
        );
    });
}

module.exports = {
    updateBuildStatus,
    updateStepStop,
    getCurrentStep,
    createBuildEvent,
    getPipelineAdmin,
    updateBuild
};
