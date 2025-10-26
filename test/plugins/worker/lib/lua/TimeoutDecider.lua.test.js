'use strict';

const { assert } = require('chai');
const LuaTestHelper = require('./luaTestHelper');

describe('TimeoutDecider.lua (Lua Script Tests)', () => {
    let helper;

    beforeEach(async () => {
        helper = new LuaTestHelper();
        await helper.start(); // Start real Redis server
    });

    afterEach(async () => {
        await helper.cleanup();
    });

    describe('parseTimeout', () => {
        it('should return parsed timeout when valid number', async () => {
            const result = await helper.executeModuleFunction('TimeoutDecider.lua', 'parseTimeout', ['120', 90]);

            assert.strictEqual(result, 120);
        });

        it('should return default when NaN', async () => {
            const result = await helper.executeModuleFunction('TimeoutDecider.lua', 'parseTimeout', ['invalid', 90]);

            assert.strictEqual(result, 90);
        });

        it('should return default when null', async () => {
            const result = await helper.executeModuleFunction('TimeoutDecider.lua', 'parseTimeout', [null, 90]);

            assert.strictEqual(result, 90);
        });

        it('should use default of 90 when not specified', async () => {
            const result = await helper.executeModuleFunction('TimeoutDecider.lua', 'parseTimeout', ['invalid', null]);

            assert.strictEqual(result, 90);
        });

        it('should handle zero timeout', async () => {
            const result = await helper.executeModuleFunction('TimeoutDecider.lua', 'parseTimeout', ['0', 90]);

            assert.strictEqual(result, 0);
        });

        it('should handle string numbers', async () => {
            const result = await helper.executeModuleFunction('TimeoutDecider.lua', 'parseTimeout', ['45', 90]);

            assert.strictEqual(result, 45);
        });
    });

    describe('hasTimedOut', () => {
        const currentTime = new Date('2025-01-15T12:00:00Z').getTime();

        it('should return false when no start time', async () => {
            const result = await helper.executeModuleFunction('TimeoutDecider.lua', 'hasTimedOut', [
                null, // startTime
                currentTime,
                90, // timeoutMinutes
                1 // bufferMinutes
            ]);

            assert.isFalse(result.hasTimedOut);
            assert.strictEqual(result.reason, 'NO_START_TIME');
            assert.strictEqual(result.elapsedMinutes, 0);
        });

        it('should return false when within timeout', async () => {
            const startTime = new Date('2025-01-15T11:00:00Z').getTime(); // 1 hour ago

            const result = await helper.executeModuleFunction('TimeoutDecider.lua', 'hasTimedOut', [
                startTime,
                currentTime,
                90,
                1
            ]);

            assert.isFalse(result.hasTimedOut);
            assert.strictEqual(result.reason, 'WITHIN_TIMEOUT');
            assert.strictEqual(result.elapsedMinutes, 60);
            assert.strictEqual(result.effectiveTimeout, 91);
        });

        it('should return true when timeout exceeded', async () => {
            const startTime = new Date('2025-01-15T10:00:00Z').getTime(); // 2 hours ago

            const result = await helper.executeModuleFunction('TimeoutDecider.lua', 'hasTimedOut', [
                startTime,
                currentTime,
                90,
                1
            ]);

            assert.isTrue(result.hasTimedOut);
            assert.strictEqual(result.reason, 'TIMEOUT_EXCEEDED');
            assert.strictEqual(result.elapsedMinutes, 120);
            assert.strictEqual(result.effectiveTimeout, 91);
        });

        it('should handle exactly at timeout boundary', async () => {
            const startTime = new Date('2025-01-15T10:29:00Z').getTime(); // 91 minutes ago

            const result = await helper.executeModuleFunction('TimeoutDecider.lua', 'hasTimedOut', [
                startTime,
                currentTime,
                90,
                1
            ]);

            assert.isFalse(result.hasTimedOut); // 91 <= 91, not greater
            assert.strictEqual(result.elapsedMinutes, 91);
        });

        it('should use default buffer of 1 minute', async () => {
            const startTime = new Date('2025-01-15T11:00:00Z').getTime();

            const result = await helper.executeModuleFunction('TimeoutDecider.lua', 'hasTimedOut', [
                startTime,
                currentTime,
                90,
                null // bufferMinutes not specified
            ]);

            assert.strictEqual(result.effectiveTimeout, 91); // 90 + 1 (default)
        });
    });

    describe('isEligibleForTimeout', () => {
        const buildId = 123;

        it('should return not eligible when build config does not exist', async () => {
            const result = await helper.executeModuleFunction('TimeoutDecider.lua', 'isEligibleForTimeout', [
                buildId,
                buildId, // runningBuildId
                false // buildConfigExists
            ]);

            assert.isFalse(result.eligible);
            assert.strictEqual(result.reason, 'BUILD_COMPLETED');
            assert.isTrue(result.shouldCleanup);
        });

        it('should return not eligible when different build is running', async () => {
            const result = await helper.executeModuleFunction('TimeoutDecider.lua', 'isEligibleForTimeout', [
                123,
                456, // different runningBuildId
                true
            ]);

            assert.isFalse(result.eligible);
            assert.strictEqual(result.reason, 'NOT_RUNNING');
            assert.isTrue(result.shouldCleanup);
        });

        it('should return eligible when running build matches', async () => {
            const result = await helper.executeModuleFunction('TimeoutDecider.lua', 'isEligibleForTimeout', [
                123,
                123, // matching runningBuildId
                true
            ]);

            assert.isTrue(result.eligible);
            assert.strictEqual(result.reason, 'ELIGIBLE');
            assert.isFalse(result.shouldCleanup);
        });

        it('should return not eligible when no running build', async () => {
            const result = await helper.executeModuleFunction('TimeoutDecider.lua', 'isEligibleForTimeout', [
                123,
                null, // no running build
                true
            ]);

            assert.isFalse(result.eligible);
            assert.strictEqual(result.reason, 'NO_RUNNING_BUILD');
            assert.isTrue(result.shouldCleanup);
        });

        it('should handle string buildId comparison', async () => {
            const result = await helper.executeModuleFunction('TimeoutDecider.lua', 'isEligibleForTimeout', [
                '123', // string buildId
                123, // number runningBuildId
                true
            ]);

            assert.isTrue(result.eligible);
            assert.strictEqual(result.reason, 'ELIGIBLE');
        });
    });

    describe('computeAction', () => {
        it('should return CLEANUP when not eligible and should cleanup', async () => {
            const timeoutCheck = {
                hasTimedOut: false,
                elapsedMinutes: 60,
                effectiveTimeout: 91,
                reason: 'WITHIN_TIMEOUT'
            };

            const eligibilityCheck = {
                eligible: false,
                reason: 'BUILD_COMPLETED',
                shouldCleanup: true
            };

            const result = await helper.executeModuleFunction('TimeoutDecider.lua', 'computeAction', [
                timeoutCheck,
                eligibilityCheck,
                90
            ]);

            assert.strictEqual(result.action, 'CLEANUP');
            assert.strictEqual(result.reason, 'BUILD_COMPLETED');
            assert.isTrue(result.shouldCleanup);
        });

        it('should return SKIP when not eligible and no cleanup needed', async () => {
            const timeoutCheck = {
                hasTimedOut: false,
                elapsedMinutes: 60,
                effectiveTimeout: 91,
                reason: 'WITHIN_TIMEOUT'
            };

            const eligibilityCheck = {
                eligible: false,
                reason: 'NOT_RUNNING',
                shouldCleanup: false
            };

            const result = await helper.executeModuleFunction('TimeoutDecider.lua', 'computeAction', [
                timeoutCheck,
                eligibilityCheck,
                90
            ]);

            assert.strictEqual(result.action, 'SKIP');
            assert.strictEqual(result.reason, 'NOT_RUNNING');
            assert.isFalse(result.shouldCleanup);
        });

        it('should return SKIP when eligible but not timed out', async () => {
            const timeoutCheck = {
                hasTimedOut: false,
                elapsedMinutes: 60,
                effectiveTimeout: 91,
                reason: 'WITHIN_TIMEOUT'
            };

            const eligibilityCheck = {
                eligible: true,
                reason: 'ELIGIBLE',
                shouldCleanup: false
            };

            const result = await helper.executeModuleFunction('TimeoutDecider.lua', 'computeAction', [
                timeoutCheck,
                eligibilityCheck,
                90
            ]);

            assert.strictEqual(result.action, 'SKIP');
            assert.strictEqual(result.reason, 'WITHIN_TIMEOUT');
            assert.strictEqual(result.elapsedMinutes, 60);
            assert.strictEqual(result.timeoutMinutes, 91);
        });

        it('should return TIMEOUT when eligible and timed out', async () => {
            const timeoutCheck = {
                hasTimedOut: true,
                elapsedMinutes: 120,
                effectiveTimeout: 91,
                reason: 'TIMEOUT_EXCEEDED'
            };

            const eligibilityCheck = {
                eligible: true,
                reason: 'ELIGIBLE',
                shouldCleanup: false
            };

            const result = await helper.executeModuleFunction('TimeoutDecider.lua', 'computeAction', [
                timeoutCheck,
                eligibilityCheck,
                90
            ]);

            assert.strictEqual(result.action, 'TIMEOUT');
            assert.strictEqual(result.reason, 'BUILD_TIMEOUT');
            assert.strictEqual(result.timeoutMinutes, 91);
            assert.strictEqual(result.elapsedMinutes, 120);
        });

        it('should prioritize ineligibility over timeout', async () => {
            const timeoutCheck = {
                hasTimedOut: true,
                elapsedMinutes: 120,
                effectiveTimeout: 91,
                reason: 'TIMEOUT_EXCEEDED'
            };

            const eligibilityCheck = {
                eligible: false,
                reason: 'BUILD_COMPLETED',
                shouldCleanup: true
            };

            const result = await helper.executeModuleFunction('TimeoutDecider.lua', 'computeAction', [
                timeoutCheck,
                eligibilityCheck,
                90
            ]);

            assert.strictEqual(result.action, 'CLEANUP');
            assert.strictEqual(result.reason, 'BUILD_COMPLETED');
        });
    });
});
