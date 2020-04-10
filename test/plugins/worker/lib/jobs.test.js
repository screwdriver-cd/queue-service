'use strict';

const { assert } = require('chai');
const mockery = require('mockery');
const sinon = require('sinon');
const fullConfig = {
    annotations: {
        'beta.screwdriver.cd/executor': 'k8s'
    },
    buildId: 8609,
    jobId: 777,
    blockedBy: [777],
    container: 'node:4',
    apiUri: 'http://api.com',
    token: 'asdf'
};
const partialConfig = {
    buildId: 8609,
    jobId: 777,
    blockedBy: [777]
};

sinon.assert.expose(assert, { prefix: '' });

describe('Jobs Unit Test', () => {
    let jobs;
    let mockExecutor;
    let mockExecutorRouter;
    let mockRedis;
    let mockRedisObj;
    let mockBlockedBy;
    let mockFilter;
    let mockRabbitmqConfig;
    let mockRabbitmqConfigObj;
    let mockAmqp;
    let mockRabbitmqConnection;
    let mockRabbitmqCh;
    let mockRedisConfig;

    before(() => {
        mockery.enable({
            useCleanCache: true,
            warnOnUnregistered: false
        });
    });

    beforeEach(() => {
        mockExecutor = {
            start: sinon.stub(),
            stop: sinon.stub()
        };

        mockRedisObj = {
            hget: sinon.stub(),
            hdel: sinon.stub(),
            del: sinon.stub(),
            get: sinon.stub(),
            lrem: sinon.stub().resolves()
        };

        mockRabbitmqCh = {
            publish: sinon.stub().resolves(null),
            assertExchange: sinon.stub().resolves(null),
            close: sinon.stub().resolves(null)
        };

        mockRabbitmqConnection = {
            on: sinon.stub(),
            createChannel: sinon.stub().returns(mockRabbitmqCh)
        };

        mockAmqp = {
            connect: sinon.stub().returns(mockRabbitmqConnection)
        };

        mockRabbitmqConfigObj = {
            schedulerMode: false,
            amqpURI: 'amqp://localhost:5672',
            exchange: 'build',
            connectOptions: '{ json: true, heartbeatIntervalInSeconds: 20, reconnectTimeInSeconds: 30 }'
        };

        mockRedisConfig = {
            connectionDetails: {
                host: '127.0.0.1',
                options: {
                    password: 'test123',
                    tls: false
                },
                port: 6379,
                database: 0
            },
            queuePrefix: '',
            runningJobsPrefix: 'running_job_',
            waitingJobsPrefix: 'waiting_job_'
        };

        mockRabbitmqConfig = {
            getConfig: sinon.stub().returns(mockRabbitmqConfigObj)
        };

        mockExecutorRouter = function() {
            return mockExecutor;
        };
        mockery.registerMock('screwdriver-executor-router', mockExecutorRouter);

        mockery.registerMock('amqp-connection-manager', mockAmqp);

        mockRedis = sinon.stub().returns(mockRedisObj);
        mockery.registerMock('ioredis', mockRedis);

        mockery.registerMock('../../../config/rabbitmq', mockRabbitmqConfig);
        mockery.registerMock('../../../config/redis', mockRedisConfig);

        mockBlockedBy = {
            BlockedBy: sinon.stub().returns()
        };
        mockery.registerMock('./BlockedBy', mockBlockedBy);

        mockFilter = {
            Filter: sinon.stub().returns()
        };
        mockery.registerMock('./Filter', mockFilter);

        // eslint-disable-next-line global-require
        jobs = require('../../../../plugins/worker/lib/jobs');
    });

    afterEach(() => {
        mockery.deregisterAll();
        mockery.resetCache();
    });

    after(() => {
        mockery.disable();
    });

    describe('redis constructor', () => {
        it('creates a redis connection given a valid config', () => {
            const expectedPort = 6379;
            const expectedHost = '127.0.0.1';
            const expectedOptions = {
                password: 'test123',
                tls: false
            };

            assert.calledWith(mockRedis, expectedPort, expectedHost, expectedOptions);
        });
    });

    describe('start', () => {
        it('constructs start job correctly', () =>
            assert.deepEqual(jobs.start, {
                plugins: [mockFilter.Filter, 'Retry', mockBlockedBy.BlockedBy],
                pluginOptions: {
                    Retry: {
                        retryLimit: 3,
                        retryDelay: 5000
                    },
                    BlockedBy: {
                        reenqueueWaitTime: 1,
                        blockTimeout: 120,
                        blockedBySelf: true,
                        collapse: true
                    }
                },
                perform: jobs.start.perform
            }));

        it('starts a job', () => {
            mockExecutor.start.resolves(null);
            mockRedisObj.hget.resolves(JSON.stringify(fullConfig));

            return jobs.start.perform(partialConfig).then(result => {
                assert.isNull(result);

                assert.calledWith(mockExecutor.start, fullConfig);
                assert.calledWith(mockRedisObj.hget, 'buildConfigs', fullConfig.buildId);
            });
        });

        it('enqueus a start job with scheduler mode', () => {
            mockRabbitmqConfigObj.schedulerMode = true;
            mockRabbitmqConfig.getConfig.returns(mockRabbitmqConfigObj);
            fullConfig.buildClusterName = 'sd';
            mockRedisObj.hget.resolves(JSON.stringify(fullConfig));
            const { amqpURI, exchange, connectOptions } = mockRabbitmqConfigObj;

            return jobs.start.perform(partialConfig).then(result => {
                delete fullConfig.buildClusterName;
                const msg = {
                    job: 'start',
                    buildConfig: fullConfig
                };

                assert.isNull(result);
                assert.calledWith(mockRedisObj.hget, 'buildConfigs', fullConfig.buildId);
                assert.calledWith(mockAmqp.connect, [amqpURI], connectOptions);
                assert.calledOnce(mockRabbitmqConnection.createChannel);
                assert.calledWith(mockRabbitmqCh.publish, exchange, 'sd', msg, {
                    contentType: 'application/json',
                    persistent: true
                });
                assert.calledOnce(mockRabbitmqCh.close);
                assert.notCalled(mockExecutor.start);
            });
        });

        it('close the channel when fail to publish the msg', () => {
            const expectedError = new Error('failed to publish');

            mockRedisObj.hget.resolves(JSON.stringify(fullConfig));
            mockRabbitmqConfigObj.schedulerMode = true;
            mockRabbitmqConfig.getConfig.returns(mockRabbitmqConfigObj);
            fullConfig.buildClusterName = 'sd';
            mockRabbitmqCh.publish.rejects(expectedError);

            return jobs.start.perform({}).then(
                () => {
                    assert.fail('Should not get here');
                },
                err => {
                    assert.calledOnce(mockRabbitmqCh.close);
                    assert.deepEqual(err, expectedError);
                }
            );
        });

        it('returns an error from executor', () => {
            mockRedisObj.hget.resolves('{}');
            mockRedisObj.hdel.resolves(1);

            const expectedError = new Error('executor.start Error');

            mockExecutor.start.rejects(expectedError);

            return jobs.start.perform({}).then(
                () => {
                    assert.fail('Should not get here');
                },
                err => {
                    assert.deepEqual(err, expectedError);
                }
            );
        });

        it('returns an error when redis fails to get a config', () => {
            const expectedError = new Error('hget error');

            mockRedisObj.hget.rejects(expectedError);

            return jobs.start.perform({}).then(
                () => {
                    assert.fail('Should not get here');
                },
                err => {
                    assert.deepEqual(err, expectedError);
                }
            );
        });
    });

    describe('stop', () => {
        it('constructs stop job correctly', () =>
            assert.deepEqual(jobs.stop, {
                plugins: [mockFilter.Filter, 'Retry'],
                pluginOptions: {
                    Retry: {
                        retryLimit: 3,
                        retryDelay: 5000
                    }
                },
                perform: jobs.stop.perform
            }));

        it('do not call executor stop if job has not started', () => {
            const stopConfig = { started: false, ...partialConfig };

            mockExecutor.stop.resolves(null);
            mockRedisObj.hget.resolves(JSON.stringify(fullConfig));
            mockRedisObj.hdel.resolves(1);
            mockRedisObj.del.resolves(null);
            mockRedisObj.get.withArgs('running_job_777').resolves('1000');

            return jobs.stop.perform(stopConfig).then(result => {
                assert.isNull(result);
                assert.calledWith(mockRedisObj.hget, 'buildConfigs', fullConfig.buildId);
                assert.calledWith(mockRedisObj.hdel, 'buildConfigs', fullConfig.buildId);
                assert.notCalled(mockRedisObj.del);
                assert.calledWith(mockRedisObj.lrem, 'waiting_job_777', 0, fullConfig.buildId);
                assert.notCalled(mockExecutor.stop);
            });
        });

        it('stops a job', () => {
            mockExecutor.stop.resolves(null);
            mockRedisObj.hget.resolves(JSON.stringify(fullConfig));
            mockRedisObj.hdel.resolves(1);
            mockRedisObj.del.resolves(null);
            mockRedisObj.get.withArgs('running_job_777').resolves(fullConfig.buildId);

            return jobs.stop.perform(partialConfig).then(result => {
                assert.isNull(result);
                assert.calledWith(mockRedisObj.hget, 'buildConfigs', fullConfig.buildId);
                assert.calledWith(mockRedisObj.hdel, 'buildConfigs', fullConfig.buildId);
                assert.calledWith(mockRedisObj.del, 'running_job_777');
                assert.calledWith(mockRedisObj.lrem, 'waiting_job_777', 0, fullConfig.buildId);
                assert.calledWith(mockExecutor.stop, {
                    annotations: fullConfig.annotations,
                    buildId: fullConfig.buildId
                });
            });
        });

        it('enqueus a stop job with scheduler mode', () => {
            fullConfig.buildClusterName = 'sd';
            mockExecutor.stop.resolves(null);
            mockRedisObj.hget.resolves(JSON.stringify(fullConfig));
            mockRedisObj.hdel.resolves(1);
            mockRedisObj.del.resolves(null);
            mockRedisObj.get.withArgs('running_job_777').resolves(fullConfig.buildId);
            mockRabbitmqConfigObj.schedulerMode = true;
            mockRabbitmqConfig.getConfig.returns(mockRabbitmqConfigObj);
            const { amqpURI, exchange, connectOptions } = mockRabbitmqConfigObj;

            return jobs.stop.perform(partialConfig).then(result => {
                delete fullConfig.buildClusterName;
                const msg = {
                    job: 'stop',
                    buildConfig: {
                        buildId: fullConfig.buildId,
                        annotations: fullConfig.annotations,
                        token: fullConfig.token
                    }
                };

                assert.isNull(result);
                assert.calledWith(mockRedisObj.hget, 'buildConfigs', fullConfig.buildId);
                assert.calledWith(mockRedisObj.hdel, 'buildConfigs', fullConfig.buildId);
                assert.calledWith(mockRedisObj.del, 'running_job_777');
                assert.calledWith(mockRedisObj.lrem, 'waiting_job_777', 0, fullConfig.buildId);
                assert.calledWith(mockRedisObj.hget, 'buildConfigs', fullConfig.buildId);
                assert.calledWith(mockAmqp.connect, [amqpURI], connectOptions);
                assert.calledOnce(mockRabbitmqConnection.createChannel);
                assert.calledWith(mockRabbitmqCh.publish, exchange, 'sd', msg, {
                    contentType: 'application/json',
                    persistent: true
                });
                assert.calledOnce(mockRabbitmqCh.close);
                assert.notCalled(mockExecutor.stop);
            });
        });

        it('stop a build anyway when redis fails to get a config', () => {
            const expectedError = new Error('hget error');

            mockExecutor.stop.resolves(null);
            mockRedisObj.hget.rejects(expectedError);

            return jobs.stop.perform(partialConfig).then(result => {
                assert.isNull(result);
                assert.calledWith(mockRedisObj.hget, 'buildConfigs', fullConfig.buildId);
                assert.calledWith(mockExecutor.stop, {
                    buildId: fullConfig.buildId
                });
            });
        });

        it('returns an error from stopping executor', () => {
            const expectedError = new Error('executor.stop Error');

            mockRedisObj.hget.resolves('{}');
            mockRedisObj.hdel.resolves(1);
            mockExecutor.stop.rejects(expectedError);

            return jobs.stop.perform({}).then(
                () => {
                    assert.fail('Should not get here');
                },
                err => {
                    assert.deepEqual(err, expectedError);
                }
            );
        });

        it('returns an error when redis fails to remove a config', () => {
            const expectedError = new Error('hdel error');

            mockRedisObj.hget.resolves('{}');
            mockRedisObj.hdel.rejects(expectedError);

            return jobs.stop.perform({}).then(
                () => {
                    assert.fail('Should not get here');
                },
                err => {
                    assert.deepEqual(err, expectedError);
                }
            );
        });
    });
});
