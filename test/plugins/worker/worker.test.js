'use strict';

const { assert } = require('chai');
const { EventEmitter } = require('events');
const mockery = require('mockery');
const sinon = require('sinon');
const util = require('util');

sinon.assert.expose(assert, { prefix: '' });

describe('Schedule test', () => {
    const worker = 'abc';
    const pid = '111';
    const plugin = {};
    const result = 'result';
    const duration = 10;
    const error = 'error';
    const verb = '+';
    const delay = '3ms';
    const workerId = 1;
    const job = { args: [{ buildId: 1 }] };
    const queue = 'testbuilds';
    const workerConfig = {
        queues: ['mockQueuePrefix_builds', 'mockQueuePrefix_cache', 'mockQueuePrefix_webhooks'],
        minTaskProcessors: 123,
        maxTaskProcessors: 234,
        checkTimeout: 345,
        maxEventLoopDelay: 456
    };

    let mockJobs;
    let MultiWorker;
    let Scheduler;
    let nrMockClass;
    let winstonMock;
    let requestMock;
    let redisConfigMock;
    let workerObj;
    let testWorker;
    let testScheduler;
    let helperMock;
    let processExitMock;
    let mockRedis;
    let mockRedisObj;
    let configMock;
    let timeoutMock;
    let clock;
    let mockRedlockObj;
    let mockRedlock;

    before(() => {
        mockery.enable({
            useCleanCache: true,
            warnOnUnregistered: false
        });
    });

    beforeEach(() => {
        mockJobs = {
            start: sinon.stub(),
            clear: sinon.stub()
        };
        MultiWorker = sinon.stub();
        MultiWorker.prototype.start = () => {};
        MultiWorker.prototype.end = sinon.stub();

        Scheduler = sinon.stub();
        Scheduler.prototype.start = () => {};
        Scheduler.prototype.connect = async () => {};
        Scheduler.prototype.end = sinon.stub();

        util.inherits(MultiWorker, EventEmitter);
        util.inherits(Scheduler, EventEmitter);
        nrMockClass = {
            MultiWorker,
            Scheduler
        };
        winstonMock = {
            info: sinon.stub(),
            error: sinon.stub()
        };
        requestMock = sinon.stub();
        helperMock = {
            updateBuildStatus: sinon.stub()
        };
        timeoutMock = {
            checkWithBackOff: sinon.stub()
        };
        processExitMock = sinon.stub();
        process.exit = processExitMock;
        redisConfigMock = {
            connectionDetails: {
                redisOptions: {
                    host: '127.0.0.1',
                    password: 'test123',
                    tls: false,
                    port: 1234,
                    database: 0
                }
            },
            queueNamespace: 'testresque',
            queuePrefix: 'mockQueuePrefix_'
        };
        mockRedisObj = {
            hget: sinon.stub().resolves('{"apiUri": "foo.bar", "token": "fake"}'),
            on: sinon.stub()
        };
        mockRedlockObj = {
            lock: sinon.stub().resolves()
        };
        mockRedlock = sinon.stub().returns(mockRedlockObj);
        mockRedis = sinon.stub().returns(mockRedisObj);
        configMock = {
            get: sinon.stub()
        };
        mockery.registerMock('./lib/jobs', mockJobs);
        mockery.registerMock('node-resque', nrMockClass);
        mockery.registerMock('request', requestMock);
        mockery.registerMock('../../config/redis', redisConfigMock);
        mockery.registerMock('../config/redis', redisConfigMock);
        mockery.registerMock('ioredis', mockRedis);
        mockery.registerMock('redlock', mockRedlock);
        mockery.registerMock('../helper', helperMock);
        mockery.registerMock('./lib/timeout', timeoutMock);
        mockery.registerMock('config', configMock);
        mockery.registerMock('screwdriver-logger', winstonMock);
        configMock.get.withArgs('worker').returns(workerConfig);

        // eslint-disable-next-line global-require
        workerObj = require('../../../plugins/worker/worker');
        testWorker = workerObj.multiWorker;
        testScheduler = workerObj.scheduler;
        workerObj.invoke();
    });

    afterEach(() => {
        mockery.deregisterAll();
        mockery.resetCache();
        process.removeAllListeners('SIGTERM');
    });

    after(() => {
        mockery.disable();
    });

    describe('shutDownAll', () => {
        it('logs error and then end scheduler when it fails to end worker', async () => {
            const expectedErr = new Error('failed');

            testWorker.end = sinon.stub().rejects(expectedErr);
            testScheduler.end = sinon.stub().resolves(null);

            await workerObj.shutDownAll(testWorker, testScheduler);
            assert.calledWith(winstonMock.error, `failed to end the worker: ${expectedErr}`);
            assert.calledOnce(testScheduler.end);
        });

        it('logs error when it fails to end scheduler', async () => {
            const expectedErr = new Error('failed');

            testWorker.end = sinon.stub().resolves(null);
            testScheduler.end = sinon.stub().rejects(expectedErr);
            try {
                await workerObj.shutDownAll(testWorker, testScheduler);
            } catch (err) {
                assert.isNotNull(err);
            }
            assert.calledWith(winstonMock.error, `failed to end the scheduler: ${expectedErr}`);
        });

        it('no error when it successfully ends both scheduler and worker', async () => {
            testWorker.end.resolves();
            testScheduler.end.resolves();

            try {
                await workerObj.shutDownAll(testWorker, testScheduler);
            } catch (err) {
                assert.isNull(err);
            }
        });
    });

    describe('event handler', () => {
        it('logs the correct message for worker', () => {
            testWorker.emit('start', workerId);
            assert.calledWith(winstonMock.info, `queueWorker->worker[${workerId}] started`);

            testWorker.emit('end', workerId);
            assert.calledWith(winstonMock.info, `queueWorker->worker[${workerId}] ended`);

            testWorker.emit('cleaning_worker', workerId, worker, pid);
            assert.calledWith(winstonMock.info, `queueWorker->cleaning old worker ${worker}${workerId} pid ${pid}`);

            testWorker.emit('poll', workerId, queue);
            assert.notCalled(timeoutMock.checkWithBackOff);

            testWorker.emit('poll', workerId, 'builds');
            assert.calledWith(winstonMock.info, `queueWorker->worker[${workerId}] polling builds`);
            assert.calledWith(timeoutMock.checkWithBackOff, mockRedisObj, mockRedlockObj, workerId);

            testWorker.emit('job', workerId, queue, job);
            assert.calledWith(
                winstonMock.info,
                `queueWorker->worker[${workerId}] working job ${queue} ${JSON.stringify(job)}`
            );

            const cacheJob = { id: 123, resource: 'caches' };

            testWorker.emit('job', workerId, 'cache', cacheJob);
            assert.calledWith(
                winstonMock.info,
                `queueWorker->worker[${workerId}] working job cache ${JSON.stringify(cacheJob)}`
            );

            testWorker.emit('reEnqueue', workerId, queue, job, plugin);
            assert.calledWith(
                winstonMock.info,
                // eslint-disable-next-line max-len
                `queueWorker->worker[${workerId}] reEnqueue job ` +
                    `(${JSON.stringify(plugin)}) ${queue} ${JSON.stringify(job)}`
            );

            testWorker.emit('success', workerId, queue, job, result, duration);
            assert.calledWith(
                winstonMock.info,
                `queueWorker->worker[${workerId}] ${job} success ${queue} ${JSON.stringify(
                    job
                )} >> ${result} (${duration}ms)`
            );

            testWorker.emit('error', workerId, queue, job, error);
            assert.calledWith(
                winstonMock.error,
                `queueWorker->worker[${workerId}] error ${queue} ${JSON.stringify(job)} >> ${error}`
            );

            testWorker.emit('pause', workerId);
            assert.calledWith(winstonMock.info, `queueWorker->worker[${workerId}] paused`);

            testWorker.emit('multiWorkerAction', verb, delay);
            assert.calledWith(
                winstonMock.info,
                `queueWorker->*** checked for worker status: ${verb} (event loop delay: ${delay}ms)`
            );
        });

        /* Failure case is special because it needs to wait for the updateBuildStatus to finish then do worker logging.
         * We cannot guarantee the logs are executed sequentally because of event emitter.
         * Therefore, need to add a sleep after emit the event and assert afterward.
         */
        it('tests worker failure by some reason', async () => {
            const updateConfig = {
                buildId: 1,
                redisInstance: mockRedisObj,
                status: 'FAILURE',
                statusMessage: 'failure'
            };
            const sleep = async ms => new Promise(resolve => setTimeout(resolve, ms));
            const failure = 'failure';

            // When updateBuildStatus succeeds
            let errMsg =
                `queueWorker->worker[${workerId}] ` +
                `${JSON.stringify(job)} failure ${queue} ` +
                `${JSON.stringify(job)} >> successfully update build status: ${failure} (${duration}ms)`;

            helperMock.updateBuildStatus.resolves();
            testWorker.emit('failure', workerId, queue, job, failure, duration);
            await sleep(100);
            assert.calledWith(helperMock.updateBuildStatus, updateConfig);
            assert.calledWith(winstonMock.info, errMsg);

            // When updateBuildStatus fails
            const updateStatusError = new Error('Error');

            errMsg =
                `queueWorker->worker[${workerId}] ${job} failure ${queue} ` +
                `${JSON.stringify(job)} >> ${failure} (${duration}ms) ` +
                `${updateStatusError}`;

            helperMock.updateBuildStatus.rejects();
            testWorker.emit('failure', workerId, queue, job, failure, duration);
            await sleep(100);
            assert.calledWith(helperMock.updateBuildStatus, updateConfig);
            assert.calledWith(winstonMock.error, errMsg);
        });

        it('logs the correct message for scheduler', () => {
            const timestamp = 'mock timestamp';
            const workerName = 'mock workerName';
            const delta = 'mock delta';
            const errorPayload = 'mock errorPayload';

            testScheduler.emit('start');
            assert.calledWith(winstonMock.info, 'queueWorker->scheduler started');

            testScheduler.emit('end');
            assert.calledWith(winstonMock.info, 'queueWorker->scheduler ended');

            testScheduler.emit('poll');
            assert.calledWith(winstonMock.info, 'queueWorker->scheduler polling');

            testScheduler.emit('leader');
            assert.calledWith(winstonMock.info, `queueWorker->scheduler became leader`);

            testScheduler.emit('error', error);
            assert.calledWith(winstonMock.info, `queueWorker->scheduler error >> ${error}`);

            testScheduler.emit('workingTimestamp', timestamp);
            assert.calledWith(winstonMock.info, `queueWorker->scheduler working timestamp ${timestamp}`);

            testScheduler.emit('transferredJob', timestamp, job);
            assert.calledWith(
                winstonMock.info,
                `queueWorker->scheduler enqueuing job timestamp  >> ${timestamp} ${JSON.stringify(job)}`
            );

            testScheduler.emit('cleanStuckWorker', workerName, errorPayload, delta);
            assert.calledWith(
                winstonMock.info,
                `queueWorker->scheduler failing ${workerName} (stuck for ${delta}s) and failing job ${errorPayload}`
            );
        });
    });

    describe('multiWorker and cleanup', () => {
        beforeEach(() => {
            clock = sinon.useFakeTimers();
        });

        afterEach(() => {
            clock.restore();
        });
        it('is constructed correctly', () => {
            assert.calledWith(
                MultiWorker,
                sinon.match(workerConfig),
                sinon.match({
                    start: mockJobs.start,
                    clear: mockJobs.clear
                })
            );
        });

        it('shuts down worker and scheduler when cleanUp called', async () => {
            testWorker.end = sinon.stub().resolves(null);
            testScheduler.end = sinon.stub().resolves(null);

            await workerObj.cleanUp();

            await clock.runAllAsync();

            assert.calledOnce(testWorker.end);
            assert.calledOnce(testScheduler.end);
        });
    });

    describe('scheduler', () => {
        it('is constructed correctly', () => {
            const expectedConfig = {
                connection: { redis: mockRedisObj, namespace: 'testresque' }
            };

            assert.calledWith(Scheduler, sinon.match(expectedConfig));
        });
    });
});
