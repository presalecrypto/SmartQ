// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract Vesting is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant FUNDER_ROLE = keccak256("FUNDER_ROLE");

    uint256 public constant CLIFF = 30 days;
    uint256 public constant VESTING_DURATION = 90 days;
    uint256 public constant GOVERNANCE_PERIOD = 180 days;
    uint256 public constant PROPOSAL_EXPIRY = 3 days;
    uint256 public constant MAX_SIGNERS = 50;

    IERC20 public immutable token;
    address public immutable timelock;
    uint64 public immutable deployedAt;

    bool public finalized;
    uint256 public proposalNonce;
    uint256 public threshold;

    enum ProposalType { CREATE, CANCEL, FINALIZE }

    struct VestingSchedule {
        uint256 totalAllocation;
        uint256 vestingAllocation;
        uint256 released;
        uint64 start;
        bool active;
        bool cancelled;
        uint256 immediate;
    }

    struct Proposal {
        ProposalType pType;
        address user;
        uint256 amount;
        uint256 approvals;
        uint64 createdAt;
        bool executed;
    }

    mapping(address => VestingSchedule) public vesting;
    mapping(bytes32 => Proposal) public proposals;
    mapping(bytes32 => mapping(address => bool)) public approved;

    mapping(address => bool) public isSigner;
    address[] public signers;

    uint256 public totalAllocated;
    uint256 public totalReleased;
    uint256 public obligations;

    event VestingCreated(address indexed user, uint256 total, uint256 immediate, uint256 vest);
    event VestingCancelled(address indexed user, uint256 remaining);
    event TokensReleased(address indexed user, uint256 amount);
    event ProposalCreated(bytes32 indexed id, ProposalType pType, address indexed user, uint256 amount);
    event ProposalApproved(bytes32 indexed id, address indexed signer);
    event ProposalExecuted(bytes32 indexed id);
    event Finalized(uint256 timestamp);
    event GovernanceEnded();
    event Funded(address indexed from, uint256 amount);

    constructor(
        address _token,
        address _timelock,
        address[] memory _signers,
        uint256 _threshold
    ) {
        require(_token != address(0), "Invalid token");
        require(_timelock != address(0), "Invalid timelock");
        require(_signers.length > 0 && _signers.length <= MAX_SIGNERS, "Bad signers");
        require(_threshold >= 2 && _threshold <= _signers.length, "Bad threshold");

        token = IERC20(_token);
        timelock = _timelock;
        deployedAt = uint64(block.timestamp);
        threshold = _threshold;

        _grantRole(DEFAULT_ADMIN_ROLE, _timelock);
        _grantRole(FUNDER_ROLE, _timelock);

        for (uint i; i < _signers.length; i++) {
            require(_signers[i] != address(0), "Invalid signer");
            require(!isSigner[_signers[i]], "Duplicate signer");
            isSigner[_signers[i]] = true;
            signers.push(_signers[i]);
        }
    }

    modifier onlySigner() {
        require(isSigner[msg.sender], "Not signer");
        _;
    }

    modifier onlyDuringGovernance() {
        require(block.timestamp < deployedAt + GOVERNANCE_PERIOD, "Governance ended");
        _;
    }

    modifier notFinalized() {
        require(!finalized, "Finalized");
        _;
    }

    function fund(uint256 amount) external onlyRole(FUNDER_ROLE) {
        require(amount > 0, "Zero amount");
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    function createProposal(ProposalType pType, address user, uint256 amount)
        external
        onlyRole(FUNDER_ROLE)
        onlyDuringGovernance
        notFinalized
        returns (bytes32)
    {
        bytes32 id = keccak256(abi.encode(pType, user, amount, proposalNonce++));
        proposals[id] = Proposal(pType, user, amount, 0, uint64(block.timestamp), false);
        emit ProposalCreated(id, pType, user, amount);
        return id;
    }

    function approve(bytes32 id) external onlySigner onlyDuringGovernance notFinalized {
        Proposal storage p = proposals[id];
        require(p.createdAt != 0, "Invalid");
        require(!p.executed, "Executed");
        require(block.timestamp <= p.createdAt + PROPOSAL_EXPIRY, "Expired");
        require(!approved[id][msg.sender], "Approved");

        approved[id][msg.sender] = true;
        p.approvals++;
        emit ProposalApproved(id, msg.sender);
    }

    function execute(bytes32 id) external onlySigner nonReentrant onlyDuringGovernance notFinalized {
        Proposal storage p = proposals[id];
        require(p.createdAt != 0, "Invalid");
        require(!p.executed, "Executed");
        require(p.approvals >= threshold, "Not enough");
        require(block.timestamp <= p.createdAt + PROPOSAL_EXPIRY, "Expired");

        p.executed = true;

        if (p.pType == ProposalType.CREATE) {
            _create(p.user, p.amount);
        } else if (p.pType == ProposalType.CANCEL) {
            _cancel(p.user);
        } else if (p.pType == ProposalType.FINALIZE) {
            _finalize();
        }
        emit ProposalExecuted(id);
    }

    function _create(address user, uint256 amount) internal {
        require(user != address(0), "Invalid user");
        require(!vesting[user].active && !vesting[user].cancelled, "Exists");
        require(amount > 0, "Zero");

        uint256 immediate = (amount * 2500) / 10000;
        uint256 vest = amount - immediate;

        uint256 newObligations = obligations + vest;
        require(token.balanceOf(address(this)) >= newObligations, "Insufficient funding");

        vesting[user] = VestingSchedule(amount, vest, 0, uint64(block.timestamp), true, false, immediate);
        obligations = newObligations;
        totalAllocated += amount;
        totalReleased += immediate;

        if (immediate > 0) {
            token.safeTransfer(user, immediate);
        }
        emit VestingCreated(user, amount, immediate, vest);
    }

    function _cancel(address user) internal {
        VestingSchedule storage s = vesting[user];
        require(s.active && !s.cancelled, "Invalid");
        uint256 remaining = s.vestingAllocation > s.released ? s.vestingAllocation - s.released : 0;
        require(obligations >= remaining, "Underflow");

        s.cancelled = true;
        s.active = false;
        obligations -= remaining;

        if (remaining > 0) {
            token.safeTransfer(msg.sender, remaining);
        }
        emit VestingCancelled(user, remaining);
    }

    function release() external nonReentrant {
        VestingSchedule storage s = vesting[msg.sender];
        require(s.active, "Inactive");
        uint256 amount = releasable(msg.sender);
        require(amount > 0, "Nothing");
        require(obligations >= amount, "Invariant");

        s.released += amount;
        obligations -= amount;
        totalReleased += amount;
        token.safeTransfer(msg.sender, amount);
        emit TokensReleased(msg.sender, amount);
    }

    function releasable(address user) public view returns (uint256) {
        VestingSchedule storage s = vesting[user];
        if (!s.active) return 0;
        if (block.timestamp < s.start + CLIFF) return 0;
        if (block.timestamp >= s.start + VESTING_DURATION) return s.vestingAllocation - s.released;

        uint256 elapsed = block.timestamp - s.start - CLIFF;
        uint256 duration = VESTING_DURATION - CLIFF;
        uint256 vested = (s.vestingAllocation * elapsed) / duration;
        return vested > s.released ? vested - s.released : 0;
    }

    function _finalize() internal {
        require(!finalized, "Finalized");
        uint256 balance = token.balanceOf(address(this));
        require(balance >= obligations, "Insufficient");
        uint256 accounted = totalAllocated - totalReleased;
        require(accounted == obligations, "Mismatch");

        finalized = true;
        uint256 excess = balance - obligations;
        if (excess > 0) {
            token.safeTransfer(timelock, excess);
        }

        if (block.timestamp >= deployedAt + GOVERNANCE_PERIOD) {
            _revokeRole(FUNDER_ROLE, timelock);
            _revokeRole(DEFAULT_ADMIN_ROLE, timelock);
            _setRoleAdmin(FUNDER_ROLE, bytes32(0));
            _setRoleAdmin(DEFAULT_ADMIN_ROLE, bytes32(0));
            emit GovernanceEnded();
        }
        emit Finalized(block.timestamp);
    }

    function getSigners() external view returns (address[] memory) { return signers; }
    function getProposal(bytes32 id) external view returns (Proposal memory) { return proposals[id]; }
    function getVesting(address user) external view returns (VestingSchedule memory) { return vesting[user]; }
    function getProposalApproval(bytes32 id, address signer) external view returns (bool) { return approved[id][signer]; }
}
