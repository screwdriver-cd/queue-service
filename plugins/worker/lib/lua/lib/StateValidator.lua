--[[
    StateValidator
]]

local StateValidator = {}

-- Define state constants
StateValidator.STATES = {
    QUEUED = "QUEUED",
    BLOCKED = "BLOCKED",
    READY = "READY",
    RUNNING = "RUNNING",
    SUCCESS = "SUCCESS",
    FAILURE = "FAILURE",
    ABORTED = "ABORTED",
    COLLAPSED = "COLLAPSED"
}

-- Define action constants
StateValidator.ACTIONS = {
    START = "START",
    BLOCK = "BLOCK",
    COLLAPSE = "COLLAPSE",
    ABORT = "ABORT",
    SKIP = "SKIP"
}

--[[
    Compute action based on current conditions
    Priority: ABORT > COLLAPSE > BLOCK > START

    @param isAborted - Whether build was aborted
    @param isBlocked - Whether build is blocked by dependencies
    @param shouldCollapse - Whether build should be collapsed
    @param isRetry - Whether this is a retry attempt
    @return {action, reason, priority, nextState}
]]
function StateValidator.computeAction(isAborted, isBlocked, shouldCollapse, isRetry)
    -- Priority 1: ABORT (highest priority)
    if isAborted then
        return {
            action = StateValidator.ACTIONS.ABORT,
            reason = "BUILD_ABORTED",
            priority = 1,
            nextState = StateValidator.STATES.ABORTED
        }
    end

    -- Priority 2: COLLAPSE
    if shouldCollapse then
        return {
            action = StateValidator.ACTIONS.COLLAPSE,
            reason = "NEWER_BUILD_EXISTS",
            priority = 2,
            nextState = StateValidator.STATES.COLLAPSED
        }
    end

    -- Priority 3: BLOCK
    if isBlocked then
        return {
            action = StateValidator.ACTIONS.BLOCK,
            reason = "BLOCKED_BY_DEPENDENCIES",
            priority = 3,
            nextState = StateValidator.STATES.BLOCKED
        }
    end

    -- Priority 4: START (lowest priority, default action)
    return {
        action = StateValidator.ACTIONS.START,
        reason = "READY",
        priority = 4,
        nextState = StateValidator.STATES.RUNNING
    }
end

--[[
    Check if a state is terminal (no further transitions)
    @param state - State to check
    @return boolean
]]
function StateValidator.isTerminalState(state)
    return state == StateValidator.STATES.SUCCESS or
           state == StateValidator.STATES.FAILURE or
           state == StateValidator.STATES.ABORTED or
           state == StateValidator.STATES.COLLAPSED
end

--[[
    Validate if a state transition is allowed
    @param currentState - Current state
    @param nextState - Desired next state
    @return {valid, reason}
]]
function StateValidator.isValidTransition(currentState, nextState)
    -- Terminal states cannot transition
    if StateValidator.isTerminalState(currentState) then
        return {
            valid = false,
            reason = "CURRENT_STATE_IS_TERMINAL"
        }
    end

    -- Define valid transitions
    local validTransitions = {
        [StateValidator.STATES.QUEUED] = {
            StateValidator.STATES.BLOCKED,
            StateValidator.STATES.READY,
            StateValidator.STATES.RUNNING,
            StateValidator.STATES.ABORTED,
            StateValidator.STATES.COLLAPSED
        },
        [StateValidator.STATES.BLOCKED] = {
            StateValidator.STATES.READY,
            StateValidator.STATES.RUNNING,
            StateValidator.STATES.ABORTED,
            StateValidator.STATES.COLLAPSED
        },
        [StateValidator.STATES.READY] = {
            StateValidator.STATES.RUNNING,
            StateValidator.STATES.ABORTED
        },
        [StateValidator.STATES.RUNNING] = {
            StateValidator.STATES.SUCCESS,
            StateValidator.STATES.FAILURE,
            StateValidator.STATES.ABORTED
        }
    }

    local allowedStates = validTransitions[currentState]

    if not allowedStates then
        return {
            valid = false,
            reason = "NO_TRANSITIONS_FROM_STATE"
        }
    end

    -- Check if nextState is in allowed list
    for _, allowedState in ipairs(allowedStates) do
        if nextState == allowedState then
            return {
                valid = true,
                reason = "VALID_TRANSITION"
            }
        end
    end

    return {
        valid = false,
        reason = "INVALID_TRANSITION"
    }
end

--[[
    Get the current state based on conditions
    @param hasRunningKey - Whether running key exists
    @param hasWaitingEntry - Whether build is in waiting queue
    @param isAborted - Whether build was aborted
    @return state
]]
function StateValidator.inferState(hasRunningKey, hasWaitingEntry, isAborted)
    if isAborted then
        return StateValidator.STATES.ABORTED
    end

    if hasRunningKey then
        return StateValidator.STATES.RUNNING
    end

    if hasWaitingEntry then
        return StateValidator.STATES.BLOCKED
    end

    return StateValidator.STATES.QUEUED
end

return StateValidator
