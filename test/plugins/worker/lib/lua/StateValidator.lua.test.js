'use strict';

const { assert } = require('chai');
const LuaTestHelper = require('./luaTestHelper');

describe('StateValidator.lua (Lua Script Tests)', () => {
    let helper;

    beforeEach(async () => {
        helper = new LuaTestHelper();
        await helper.start(); // Start real Redis server
    });

    afterEach(async () => {
        await helper.cleanup();
    });

    describe('computeAction', () => {
        it('should return ABORT when build is aborted (highest priority)', async () => {
            const result = await helper.executeModuleFunction('StateValidator.lua', 'computeAction', [
                true, // isAborted
                true, // isBlocked
                true, // shouldCollapse
                false // isRetry
            ]);

            assert.equal(result.action, 'ABORT');
            assert.equal(result.reason, 'BUILD_ABORTED');
            assert.equal(result.priority, 1);
            assert.equal(result.nextState, 'ABORTED');
        });

        it('should return COLLAPSE when not aborted but should collapse', async () => {
            const result = await helper.executeModuleFunction('StateValidator.lua', 'computeAction', [
                false, // isAborted
                true, // isBlocked
                true, // shouldCollapse
                false
            ]);

            assert.equal(result.action, 'COLLAPSE');
            assert.equal(result.reason, 'NEWER_BUILD_EXISTS');
            assert.equal(result.priority, 2);
            assert.equal(result.nextState, 'COLLAPSED');
        });

        it('should return BLOCK when blocked but not aborted/collapsed', async () => {
            const result = await helper.executeModuleFunction('StateValidator.lua', 'computeAction', [
                false,
                true, // isBlocked
                false,
                false
            ]);

            assert.equal(result.action, 'BLOCK');
            assert.equal(result.reason, 'BLOCKED_BY_DEPENDENCIES');
            assert.equal(result.priority, 3);
            assert.equal(result.nextState, 'BLOCKED');
        });

        it('should return START when not blocked/aborted/collapsed (default)', async () => {
            const result = await helper.executeModuleFunction('StateValidator.lua', 'computeAction', [
                false,
                false,
                false,
                false
            ]);

            assert.equal(result.action, 'START');
            assert.equal(result.reason, 'READY');
            assert.equal(result.priority, 4);
            assert.equal(result.nextState, 'RUNNING');
        });

        it('should prioritize ABORT over COLLAPSE', async () => {
            const result = await helper.executeModuleFunction('StateValidator.lua', 'computeAction', [
                true, // isAborted
                false,
                true, // shouldCollapse
                false
            ]);

            assert.equal(result.action, 'ABORT');
            assert.equal(result.priority, 1);
        });

        it('should prioritize COLLAPSE over BLOCK', async () => {
            const result = await helper.executeModuleFunction('StateValidator.lua', 'computeAction', [
                false,
                true, // isBlocked
                true, // shouldCollapse
                false
            ]);

            assert.equal(result.action, 'COLLAPSE');
            assert.equal(result.priority, 2);
        });
    });

    describe('isTerminalState', () => {
        it('should return true for SUCCESS', async () => {
            const result = await helper.executeModuleFunction('StateValidator.lua', 'isTerminalState', ['SUCCESS']);

            assert.isTrue(result);
        });

        it('should return true for FAILURE', async () => {
            const result = await helper.executeModuleFunction('StateValidator.lua', 'isTerminalState', ['FAILURE']);

            assert.isTrue(result);
        });

        it('should return true for ABORTED', async () => {
            const result = await helper.executeModuleFunction('StateValidator.lua', 'isTerminalState', ['ABORTED']);

            assert.isTrue(result);
        });

        it('should return true for COLLAPSED', async () => {
            const result = await helper.executeModuleFunction('StateValidator.lua', 'isTerminalState', ['COLLAPSED']);

            assert.isTrue(result);
        });

        it('should return false for QUEUED', async () => {
            const result = await helper.executeModuleFunction('StateValidator.lua', 'isTerminalState', ['QUEUED']);

            assert.isFalse(result);
        });

        it('should return false for BLOCKED', async () => {
            const result = await helper.executeModuleFunction('StateValidator.lua', 'isTerminalState', ['BLOCKED']);

            assert.isFalse(result);
        });

        it('should return false for RUNNING', async () => {
            const result = await helper.executeModuleFunction('StateValidator.lua', 'isTerminalState', ['RUNNING']);

            assert.isFalse(result);
        });

        it('should return false for READY', async () => {
            const result = await helper.executeModuleFunction('StateValidator.lua', 'isTerminalState', ['READY']);

            assert.isFalse(result);
        });
    });

    describe('isValidTransition', () => {
        it('should reject transition from terminal state', async () => {
            const result = await helper.executeModuleFunction('StateValidator.lua', 'isValidTransition', [
                'SUCCESS', // terminal state
                'RUNNING'
            ]);

            assert.isFalse(result.valid);
            assert.equal(result.reason, 'CURRENT_STATE_IS_TERMINAL');
        });

        it('should allow QUEUED -> BLOCKED', async () => {
            const result = await helper.executeModuleFunction('StateValidator.lua', 'isValidTransition', [
                'QUEUED',
                'BLOCKED'
            ]);

            assert.isTrue(result.valid);
            assert.equal(result.reason, 'VALID_TRANSITION');
        });

        it('should allow QUEUED -> RUNNING', async () => {
            const result = await helper.executeModuleFunction('StateValidator.lua', 'isValidTransition', [
                'QUEUED',
                'RUNNING'
            ]);

            assert.isTrue(result.valid);
        });

        it('should allow QUEUED -> ABORTED', async () => {
            const result = await helper.executeModuleFunction('StateValidator.lua', 'isValidTransition', [
                'QUEUED',
                'ABORTED'
            ]);

            assert.isTrue(result.valid);
        });

        it('should allow BLOCKED -> RUNNING', async () => {
            const result = await helper.executeModuleFunction('StateValidator.lua', 'isValidTransition', [
                'BLOCKED',
                'RUNNING'
            ]);

            assert.isTrue(result.valid);
        });

        it('should allow BLOCKED -> COLLAPSED', async () => {
            const result = await helper.executeModuleFunction('StateValidator.lua', 'isValidTransition', [
                'BLOCKED',
                'COLLAPSED'
            ]);

            assert.isTrue(result.valid);
        });

        it('should allow RUNNING -> SUCCESS', async () => {
            const result = await helper.executeModuleFunction('StateValidator.lua', 'isValidTransition', [
                'RUNNING',
                'SUCCESS'
            ]);

            assert.isTrue(result.valid);
        });

        it('should allow RUNNING -> FAILURE', async () => {
            const result = await helper.executeModuleFunction('StateValidator.lua', 'isValidTransition', [
                'RUNNING',
                'FAILURE'
            ]);

            assert.isTrue(result.valid);
        });

        it('should reject RUNNING -> QUEUED', async () => {
            const result = await helper.executeModuleFunction('StateValidator.lua', 'isValidTransition', [
                'RUNNING',
                'QUEUED'
            ]);

            assert.isFalse(result.valid);
            assert.equal(result.reason, 'INVALID_TRANSITION');
        });

        it('should reject BLOCKED -> SUCCESS', async () => {
            const result = await helper.executeModuleFunction('StateValidator.lua', 'isValidTransition', [
                'BLOCKED',
                'SUCCESS'
            ]);

            assert.isFalse(result.valid);
            assert.equal(result.reason, 'INVALID_TRANSITION');
        });
    });

    describe('inferState', () => {
        it('should infer ABORTED when isAborted is true', async () => {
            const result = await helper.executeModuleFunction('StateValidator.lua', 'inferState', [
                true, // hasRunningKey
                true, // hasWaitingEntry
                true // isAborted
            ]);

            assert.equal(result, 'ABORTED');
        });

        it('should infer RUNNING when hasRunningKey and not aborted', async () => {
            const result = await helper.executeModuleFunction('StateValidator.lua', 'inferState', [
                true, // hasRunningKey
                false,
                false
            ]);

            assert.equal(result, 'RUNNING');
        });

        it('should infer BLOCKED when hasWaitingEntry and not running', async () => {
            const result = await helper.executeModuleFunction('StateValidator.lua', 'inferState', [
                false,
                true, // hasWaitingEntry
                false
            ]);

            assert.equal(result, 'BLOCKED');
        });

        it('should infer QUEUED when no indicators', async () => {
            const result = await helper.executeModuleFunction('StateValidator.lua', 'inferState', [
                false,
                false,
                false
            ]);

            assert.equal(result, 'QUEUED');
        });

        it('should prioritize aborted over running', async () => {
            const result = await helper.executeModuleFunction('StateValidator.lua', 'inferState', [
                true, // hasRunningKey
                false,
                true // isAborted
            ]);

            assert.equal(result, 'ABORTED');
        });

        it('should prioritize running over waiting', async () => {
            const result = await helper.executeModuleFunction('StateValidator.lua', 'inferState', [
                true, // hasRunningKey
                true, // hasWaitingEntry
                false
            ]);

            assert.equal(result, 'RUNNING');
        });
    });
});
