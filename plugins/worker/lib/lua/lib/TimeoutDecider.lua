--[[
    This module determines whether a build has timed out and what action to take.
]]

local TimeoutDecider = {}

--[[
    Parse timeout value, handling NaN cases
    @param timeoutValue - Timeout value (string or number)
    @param defaultTimeout - Default timeout in minutes (default: 90)
    @return number (parsed timeout or default)
]]
function TimeoutDecider.parseTimeout(timeoutValue, defaultTimeout)
    -- Handle cjson.null for defaultTimeout (JavaScript null becomes cjson.null)
    if not defaultTimeout or defaultTimeout == cjson.null then
        defaultTimeout = 90
    end

    -- Handle cjson.null for timeoutValue
    if not timeoutValue or timeoutValue == cjson.null then
        return defaultTimeout
    end

    local parsed = tonumber(timeoutValue)

    if not parsed or parsed ~= parsed then  -- NaN check
        return defaultTimeout
    end

    return parsed
end

--[[
    Check if a build has timed out
    @param startTime - Build start timestamp (milliseconds)
    @param currentTime - Current timestamp (milliseconds)
    @param timeoutMinutes - Timeout duration in minutes
    @param bufferMinutes - Buffer time in minutes (default: 1)
    @return {hasTimedOut, elapsedMinutes, effectiveTimeout, reason}
]]
function TimeoutDecider.hasTimedOut(startTime, currentTime, timeoutMinutes, bufferMinutes)
    -- Handle cjson.null for bufferMinutes (JavaScript null becomes cjson.null)
    if not bufferMinutes or bufferMinutes == cjson.null then
        bufferMinutes = 1
    end

    -- Handle cjson.null for startTime
    if not startTime or startTime == cjson.null then
        return {
            hasTimedOut = false,
            reason = "NO_START_TIME",
            elapsedMinutes = 0,
            effectiveTimeout = timeoutMinutes + bufferMinutes
        }
    end

    local elapsedMs = currentTime - startTime
    local elapsedMinutes = math.floor(elapsedMs / 60000 + 0.5)  -- Round to nearest minute
    local effectiveTimeout = timeoutMinutes + bufferMinutes

    local timedOut = elapsedMinutes > effectiveTimeout

    return {
        hasTimedOut = timedOut,
        elapsedMinutes = elapsedMinutes,
        effectiveTimeout = effectiveTimeout,
        reason = timedOut and "TIMEOUT_EXCEEDED" or "WITHIN_TIMEOUT"
    }
end

--[[
    Check if a build is eligible for timeout action
    @param buildId - Current build ID
    @param runningBuildId - Build ID from running key (or nil)
    @param buildConfigExists - Whether build config still exists
    @return {eligible, reason, shouldCleanup}
]]
function TimeoutDecider.isEligibleForTimeout(buildId, runningBuildId, buildConfigExists)
    -- Parse buildId to number for comparison (may be string from Redis keys)
    local buildIdNum = tonumber(buildId)

    -- Build config deleted = build already completed
    if not buildConfigExists then
        return {
            eligible = false,
            reason = "BUILD_COMPLETED",
            shouldCleanup = true
        }
    end

    -- Check for nil or cjson.null (JavaScript null becomes cjson.null)
    if not runningBuildId or runningBuildId == cjson.null then
        return {
            eligible = false,
            reason = "NO_RUNNING_BUILD",
            shouldCleanup = true
        }
    end

    -- Different build running = this build not running anymore
    if tonumber(runningBuildId) ~= buildIdNum then
        return {
            eligible = false,
            reason = "NOT_RUNNING",
            shouldCleanup = true
        }
    end

    -- Running build ID matches = eligible for timeout
    return {
        eligible = true,
        reason = "ELIGIBLE",
        shouldCleanup = false
    }
end

--[[
    Compute action to take based on timeout check
    @param timeoutCheck - Result from hasTimedOut()
    @param eligibilityCheck - Result from isEligibleForTimeout()
    @param timeoutMinutes - Timeout duration for logging
    @return {action, reason, timeoutMinutes}
]]
function TimeoutDecider.computeAction(timeoutCheck, eligibilityCheck, timeoutMinutes)
    -- If not eligible, determine action based on cleanup need
    if not eligibilityCheck.eligible then
        if eligibilityCheck.shouldCleanup then
            return {
                action = "CLEANUP",
                reason = eligibilityCheck.reason,
                shouldCleanup = true
            }
        else
            return {
                action = "SKIP",
                reason = eligibilityCheck.reason,
                shouldCleanup = false
            }
        end
    end

    -- Eligible - check if timed out
    if timeoutCheck.hasTimedOut then
        return {
            action = "TIMEOUT",
            reason = "BUILD_TIMEOUT",
            timeoutMinutes = timeoutCheck.effectiveTimeout,
            elapsedMinutes = timeoutCheck.elapsedMinutes
        }
    end

    -- Eligible but not timed out yet
    return {
        action = "SKIP",
        reason = "WITHIN_TIMEOUT",
        elapsedMinutes = timeoutCheck.elapsedMinutes,
        timeoutMinutes = timeoutCheck.effectiveTimeout
    }
end

return TimeoutDecider
