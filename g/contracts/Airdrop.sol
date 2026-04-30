// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract Airdrop is AccessControl, ReentrancyGuard {

    // ============ ROLES ============
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // ============ IMMUTABLE ============
    IERC20 public immutable token;
    address public immutable timelock;
    uint64 public immutable deployedAt;

    uint256 public constant GOVERNANCE_PERIOD = 180 days;

    // ============ STATE ============
    bytes32 public merkleRoot;

    bool public initialized;
    bool public finalized;
    bool public permanentlyDisabled;

    uint256 public deadline;
    uint256 public totalClaimed;

    mapping(address => bool) public hasClaimed;

    // ============ EVENTS ============
    event MerkleRootSet(bytes32 root, uint256 deadline);
    event Claimed(address indexed user, uint256 amount);
    event Deactivated();
    event Finalized(uint256 timestamp);
    event WithdrawRemaining(address indexed to, uint256 amount);

    // ============ MODIFIERS ============
    modifier onlyActive() {
        require(!finalized, "Finalized");
        require(!permanentlyDisabled, "Disabled");
        _;
    }

    constructor(address _token, address _timelock) {
        require(_token != address(0), "Invalid token");
        require(_timelock != address(0), "Invalid timelock");

        token = IERC20(_token);
        timelock = _timelock;
        deployedAt = uint64(block.timestamp);

        _grantRole(DEFAULT_ADMIN_ROLE, _timelock);
        _grantRole(ADMIN_ROLE, _timelock);
    }

    // ============ ROLE SAFETY ============
    function grantRole(bytes32 role, address account)
        public
        override
        onlyActive
    {
        require(msg.sender == timelock, "Only timelock");
        super.grantRole(role, account);
    }

    function revokeRole(bytes32 role, address account)
        public
        override
        onlyActive
    {
        require(msg.sender == timelock, "Only timelock");
        super.revokeRole(role, account);
    }

    function renounceRole(bytes32 role, address account)
        public
        override
        onlyActive
    {
        require(msg.sender == timelock, "Only timelock");
        super.renounceRole(role, account);
    }

    // ============ INIT AIRDROP ============
    function setMerkleRoot(bytes32 _root, uint256 _deadline)
        external
        onlyRole(ADMIN_ROLE)
        onlyActive
    {
        require(!initialized, "Already initialized");
        require(_root != bytes32(0), "Invalid root");
        require(_deadline > block.timestamp + 1 days, "Invalid deadline");

        merkleRoot = _root;
        deadline = _deadline;
        initialized = true;

        emit MerkleRootSet(_root, _deadline);
    }

    // ============ DEACTIVATE ============
    function deactivate()
        external
        onlyRole(ADMIN_ROLE)
        onlyActive
    {
        require(block.timestamp < deadline, "Too late");

        permanentlyDisabled = true;

        emit Deactivated();
    }

    // ============ CLAIM ============
    function claim(uint256 amount, bytes32[] calldata proof)
        external
        nonReentrant
        onlyActive
    {
        require(initialized, "Not initialized");
        require(block.timestamp <= deadline, "Expired");
        require(!hasClaimed[msg.sender], "Already claimed");

        bytes32 leaf = keccak256(abi.encodePacked(msg.sender, amount));

        require(
            MerkleProof.verify(proof, merkleRoot, leaf),
            "Invalid proof"
        );

        hasClaimed[msg.sender] = true;
        totalClaimed += amount;

        require(token.transfer(msg.sender, amount), "Transfer failed");

        emit Claimed(msg.sender, amount);
    }

    // ============ WITHDRAW ============
    function withdrawRemaining()
        external
        onlyRole(ADMIN_ROLE)
        nonReentrant
    {
        require(block.timestamp > deadline, "Not ended");

        uint256 bal = token.balanceOf(address(this));
        require(bal > 0, "Nothing left");

        token.transfer(timelock, bal);

        emit WithdrawRemaining(timelock, bal);
    }

    // ============ FINALIZE (UNIFIED WITH ECOSYSTEM) ============
    function finalize()
        external
        onlyRole(ADMIN_ROLE)
        onlyActive
    {
        if (block.timestamp < deployedAt + GOVERNANCE_PERIOD) {
            require(msg.sender == timelock, "Only timelock in governance");
        }

        finalized = true;

        // revoke roles (same pattern as Token.sol + Vesting.sol)
        _revokeRole(ADMIN_ROLE, timelock);
        _revokeRole(DEFAULT_ADMIN_ROLE, timelock);

        _setRoleAdmin(ADMIN_ROLE, bytes32(0));
        _setRoleAdmin(DEFAULT_ADMIN_ROLE, bytes32(0));

        emit Finalized(block.timestamp);
    }

    // ============ VIEW ============
    function isFinalized() external view returns (bool) {
        return finalized;
    }

    function isActive() external view returns (bool) {
        return initialized && !finalized && !permanentlyDisabled;
    }

    function hasUserClaimed(address user) external view returns (bool) {
        return hasClaimed[user];
    }

    function getInfo()
        external
        view
        returns (
            bool active,
            bool _finalized,
            uint256 _deadline,
            uint256 remaining,
            uint256 claimed,
            uint256 timeLeft
        )
    {
        active = this.isActive();
        _finalized = finalized;
        _deadline = deadline;
        remaining = token.balanceOf(address(this));
        claimed = totalClaimed;

        if (block.timestamp >= deadline) {
            timeLeft = 0;
        } else {
            timeLeft = deadline - block.timestamp;
        }
    }
}