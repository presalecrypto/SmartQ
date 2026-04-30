// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract Vesting is AccessControl, ReentrancyGuard {

bytes32 public constant FUNDER_ROLE = keccak256("FUNDER_ROLE");  
  
uint256 public constant CLIFF = 30 days;  
uint256 public constant VESTING_DURATION = 90 days;  
uint256 public constant MAX_BATCH_SIZE = 50;  

IERC20 public immutable token;  
address public immutable timelock;  

bool public finalized;  

struct VestingSchedule {  
    uint256 totalAmount;  
    uint256 releasedAmount;  
    uint256 startTime;  
    address beneficiary;  
    bool initialized;  
    address createdBy;  
    uint256 immediateAmount;  
}  

mapping(address => VestingSchedule) public vestingSchedules;  
address[] public beneficiaries;  

uint256 public totalVested;  
uint256 public totalReleased;  

event VestingCreated(  
    address indexed beneficiary,  
    uint256 totalAmount,  
    uint256 immediateAmount,  
    address indexed createdBy,  
    uint256 startTime  
);  
event TokensReleased(address indexed beneficiary, uint256 amount, uint256 timestamp);  
event VestingCompleted(address indexed beneficiary);  
event ContractImmutable();  
event TimelockSet(address indexed timelock);  
event ReleaseFailed(address indexed beneficiary, uint256 amount);  

modifier onlyBeforeFinalize() {  
    require(!finalized, "Contract is finalized");  
    _;  
}  

modifier notInitialized(address beneficiary) {  
    require(!vestingSchedules[beneficiary].initialized, "Already exists");  
    _;  
}  

constructor(address _token, address _timelock) {  
    require(_token != address(0), "Invalid token");  
    require(_token.code.length > 0, "Token must be contract");  
    require(_timelock != address(0), "Invalid timelock");  

    token = IERC20(_token);  
    timelock = _timelock;  

    _grantRole(DEFAULT_ADMIN_ROLE, _timelock);  
    _grantRole(FUNDER_ROLE, _timelock);  

    emit TimelockSet(_timelock);  
}  

function grantRole(bytes32 role, address account) public override onlyBeforeFinalize {  
    require(  
        hasRole(getRoleAdmin(role), msg.sender) && msg.sender == timelock,  
        "Only timelock with role admin can grant"  
    );  
    super.grantRole(role, account);  
}  

function revokeRole(bytes32 role, address account) public override onlyBeforeFinalize {  
    require(  
        hasRole(getRoleAdmin(role), msg.sender) && msg.sender == timelock,  
        "Only timelock with role admin can revoke"  
    );  
    super.revokeRole(role, account);  
}  

function renounceRole(bytes32 role, address callerAccount) public override onlyBeforeFinalize {  
    require(msg.sender == timelock, "Only timelock can renounce roles");  
    super.renounceRole(role, callerAccount);  
}  

function createVesting(  
    address beneficiary,  
    uint256 amount  
)  
    external  
    nonReentrant  
    onlyRole(FUNDER_ROLE)  
    onlyBeforeFinalize  
    notInitialized(beneficiary)  
{  
    require(beneficiary != address(0), "Zero address");  
    require(amount > 0, "Amount must be > 0");  
    require(beneficiary != msg.sender, "Self vesting not allowed");  

    bool success = token.transferFrom(msg.sender, address(this), amount);  
    require(success, "Transfer failed");  

    uint256 immediateAmount = amount / 4;  
    uint256 vested = amount - immediateAmount;  

    require(vested > 0, "Invalid vesting split");  

    vestingSchedules[beneficiary] = VestingSchedule({  
        totalAmount: vested,  
        releasedAmount: 0,  
        startTime: block.timestamp,  
        beneficiary: beneficiary,  
        initialized: true,  
        createdBy: msg.sender,  
        immediateAmount: immediateAmount  
    });  


    beneficiaries.push(beneficiary);  
    totalVested += amount;  

    if (immediateAmount > 0) {  
        totalReleased += immediateAmount;  
        require(token.transfer(beneficiary, immediateAmount), "Immediate transfer failed");  
    }  

    emit VestingCreated(  
        beneficiary,  
        amount,  
        immediateAmount,  
        msg.sender,  
        block.timestamp  
    );  
}  

function releasableAmount(address beneficiary) public view returns (uint256) {  
    VestingSchedule storage s = vestingSchedules[beneficiary];  
    if (!s.initialized) return 0;  

    if (block.timestamp <= s.startTime) {  
        return 0;  
    }  

    uint256 elapsed = block.timestamp - s.startTime;  

    if (elapsed < CLIFF) return 0;  

    if (elapsed >= VESTING_DURATION) {  
        return s.totalAmount - s.releasedAmount;  
    }  

    uint256 vestedTime = elapsed - CLIFF;  
    uint256 vestingTime = VESTING_DURATION - CLIFF;  

    uint256 vested = (s.totalAmount * vestedTime) / vestingTime;  

    if (vested <= s.releasedAmount) return 0;  

    return vested - s.releasedAmount;  
}  

function vestedAmount(address beneficiary) public view returns (uint256) {  
    VestingSchedule storage s = vestingSchedules[beneficiary];  
    if (!s.initialized) return 0;  

    if (block.timestamp <= s.startTime) {  
        return 0;  
    }  

    uint256 elapsed = block.timestamp - s.startTime;  

    if (elapsed < CLIFF) return 0;  

    if (elapsed >= VESTING_DURATION) {  
        return s.totalAmount;  
    }  

    uint256 vestedTime = elapsed - CLIFF;  
    uint256 vestingTime = VESTING_DURATION - CLIFF;  

    return (s.totalAmount * vestedTime) / vestingTime;  
}  

function release() external nonReentrant {  
    VestingSchedule storage s = vestingSchedules[msg.sender];  
    require(s.initialized, "No vesting found");  

    uint256 amount = releasableAmount(msg.sender);  
    require(amount > 0, "Nothing to release");  

    require(  
    token.balanceOf(address(this)) >= amount,  
    "Insufficient contract balance"  
    );  

    s.releasedAmount += amount;  
    totalReleased += amount;  

    require(token.transfer(msg.sender, amount), "Transfer failed");  

    emit TokensReleased(msg.sender, amount, block.timestamp);  

    if (s.releasedAmount == s.totalAmount) {  
        emit VestingCompleted(msg.sender);  
    }  
}  

function releaseBatch(address[] calldata users) external nonReentrant {  
    require(users.length <= MAX_BATCH_SIZE, "Batch too large");  
    require(users.length > 0, "Empty batch");  

    for (uint256 i = 0; i < users.length; i++) {  
        address user = users[i];  

        if (user == address(0)) continue;  

        VestingSchedule storage s = vestingSchedules[user];  

        if (s.initialized) {  
            uint256 amount = releasableAmount(user);  
            if (amount > 0) {  
                require(  
                    token.balanceOf(address(this)) >= amount,  
                    "Insufficient contract balance"  
                );  

                bool ok = token.transfer(user, amount);  
                if (!ok) {  
                    emit ReleaseFailed(user, amount);  
                    continue;  
                }  

                s.releasedAmount += amount;  
                totalReleased += amount;  

                emit TokensReleased(user, amount, block.timestamp);  

                if (s.releasedAmount == s.totalAmount) {  
                    emit VestingCompleted(user);  
                }  
            }  
        }  
    }  
}  

function finalize() external onlyRole(DEFAULT_ADMIN_ROLE) onlyBeforeFinalize {  
    require(beneficiaries.length > 0, "No vesting schedules");  
    require(  
        token.balanceOf(address(this)) > 0,  
        "No tokens locked"  
    );  

    finalized = true;  

    _revokeRole(FUNDER_ROLE, timelock);  
    _revokeRole(DEFAULT_ADMIN_ROLE, timelock);  

    _setRoleAdmin(FUNDER_ROLE, bytes32(0));  
    _setRoleAdmin(DEFAULT_ADMIN_ROLE, bytes32(0));  

    emit ContractImmutable();  
}  

function getVestingInfo(address beneficiary)  
    external  
    view  
    returns (  
        uint256 total,  
        uint256 released,  
        uint256 releasable,  
        uint256 vested,  
        uint256 startTime,  
        uint256 endTime,  
        uint256 cliffEnd,  
        address creator,  
        uint256 immediateAmount,  
        bool isComplete  
    )  
{  
    VestingSchedule storage s = vestingSchedules[beneficiary];  

    if (!s.initialized) {  
        return (0, 0, 0, 0, 0, 0, 0, address(0), 0, false);  
    }  

    uint256 _releasable = releasableAmount(beneficiary);  
    uint256 _vested = vestedAmount(beneficiary);  
    bool _isComplete = s.releasedAmount == s.totalAmount;  

    return (  
        s.totalAmount,  
        s.releasedAmount,  
        _releasable,  
        _vested,  
        s.startTime,  
        s.startTime + VESTING_DURATION,  
        s.startTime + CLIFF,  
        s.createdBy,  
        s.immediateAmount,  
        _isComplete  
    );  
}  

function getAllBeneficiaries() external view returns (address[] memory) {  
    return beneficiaries;  
}  

function getBeneficiariesCount() external view returns (uint256) {  
    return beneficiaries.length;  
}  

function getContractBalance() external view returns (uint256) {  
    return token.balanceOf(address(this));  
}  

function isVestingComplete(address beneficiary) external view returns (bool) {  
    VestingSchedule storage s = vestingSchedules[beneficiary];  
    if (!s.initialized) return false;  
    return s.releasedAmount == s.totalAmount;  
}  

function timeRemaining(address beneficiary) external view returns (uint256) {  
    VestingSchedule storage s = vestingSchedules[beneficiary];  
    if (!s.initialized) return 0;  

    uint256 endTime = s.startTime + VESTING_DURATION;  
    if (block.timestamp >= endTime) return 0;  

    return endTime - block.timestamp;  
}  

function isFinalized() external view returns (bool) {  
    return finalized;  
}  

function isImmutable() external view returns (bool) {  
    return finalized && getRoleAdmin(FUNDER_ROLE) == bytes32(0);  
}  

function getVestingStatus()  
    external  
    view  
    returns (  
        bool _finalized,  
        uint256 _totalVested,  
        uint256 _totalReleased,  
        uint256 _balance,  
        uint256 _beneficiariesCount,  
        bool _isImmutable  
    )  
{  
    return (  
        finalized,  
        totalVested,  
        totalReleased,  
        token.balanceOf(address(this)),  
        beneficiaries.length,  
        this.isImmutable()  
    );  
}

}