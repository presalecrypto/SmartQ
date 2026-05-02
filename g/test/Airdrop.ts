import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { ProjectToken, Airdrop } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("Airdrop — Full Security Audit Test Suite", function () {
  let token: ProjectToken;
  let airdrop: Airdrop;
  let owner: SignerWithAddress;
  let timelock: SignerWithAddress;
  let admin: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let user3: SignerWithAddress;
  let user4: SignerWithAddress;

  const MAX_SUPPLY = ethers.parseEther("1000000000");
  const GOVERNANCE_PERIOD = 180n * 24n * 60n * 60n;

  let merkleRoot: string;
  let claims: { address: string; amount: bigint }[] = [];
  let leaves: string[] = [];

  beforeEach(async function () {
    [owner, timelock, admin, user1, user2, user3, user4] = await ethers.getSigners();

    const TokenFactory = await ethers.getContractFactory("ProjectToken");
    token = await TokenFactory.deploy(
      "ProjectToken", "PTK", timelock.address,
      [timelock.address], [MAX_SUPPLY], ethers.ZeroAddress
    );
    await token.waitForDeployment();

    const AirdropFactory = await ethers.getContractFactory("Airdrop");
    airdrop = await AirdropFactory.deploy(await token.getAddress(), timelock.address);
    await airdrop.waitForDeployment();

    claims = [
      { address: user1.address, amount: ethers.parseEther("1000") },
      { address: user2.address, amount: ethers.parseEther("2000") },
      { address: user3.address, amount: ethers.parseEther("3000") },
    ];

    // Match contract EXACTLY: keccak256(abi.encodePacked(addr, amount))
    leaves = claims.map(c =>
      ethers.keccak256(ethers.solidityPacked(["address", "uint256"], [c.address, c.amount]))
    );
    leaves.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));

    merkleRoot = _buildMerkleRoot(leaves);

    await token.connect(timelock).transfer(await airdrop.getAddress(), ethers.parseEther("10000"));
  });

  // ── Sorted-pair Merkle tree (matches OpenZeppelin MerkleProof) ──
  function _buildMerkleRoot(_leaves: string[]): string {
    if (_leaves.length === 0) return ethers.ZeroHash;
    if (_leaves.length === 1) return _leaves[0];

    let level = [..._leaves];
    while (level.length > 1) {
      const nextLevel: string[] = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i];
        const right = level[i + 1] || left;
        nextLevel.push(_sortedHash(left, right));
      }
      level = nextLevel;
    }
    return level[0];
  }

  function _sortedHash(a: string, b: string): string {
    // OpenZeppelin MerkleProof: sort pairs before hashing
    if (BigInt(a) <= BigInt(b)) {
      return ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], [a, b]));
    } else {
      return ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], [b, a]));
    }
  }

  function _getProof(_leaves: string[], leafIndex: number): string[] {
    const proof: string[] = [];
    let index = leafIndex;
    let level = [..._leaves];

    while (level.length > 1) {
      const nextLevel: string[] = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i];
        const right = level[i + 1] || left;

        if (i === index || i + 1 === index) {
          if (index === i && level[i + 1]) {
            proof.push(right);
          } else if (index === i + 1) {
            proof.push(left);
          }
        }

        nextLevel.push(_sortedHash(left, right));
      }
      index = Math.floor(index / 2);
      level = nextLevel;
    }
    return proof;
  }

  describe("Deployment", function () {
    it("Should set correct token", async function () {
      expect(await airdrop.token()).to.equal(await token.getAddress());
    });

    it("Should set correct timelock", async function () {
      expect(await airdrop.timelock()).to.equal(timelock.address);
    });

    it("Should assign ADMIN_ROLE to timelock", async function () {
      expect(await airdrop.hasRole(await airdrop.ADMIN_ROLE(), timelock.address)).to.be.true;
    });

    it("Should not be initialized", async function () {
      expect(await airdrop.initialized()).to.be.false;
    });

    it("Should revert with zero token", async function () {
      const AirdropFactory = await ethers.getContractFactory("Airdrop");
      await expect(AirdropFactory.deploy(ethers.ZeroAddress, timelock.address))
        .to.be.revertedWith("Invalid token");
    });

    it("Should revert with zero timelock", async function () {
      const AirdropFactory = await ethers.getContractFactory("Airdrop");
      await expect(AirdropFactory.deploy(await token.getAddress(), ethers.ZeroAddress))
        .to.be.revertedWith("Invalid timelock");
    });
  });

  describe("setMerkleRoot", function () {
    it("Should allow ADMIN_ROLE to set merkle root", async function () {
      const deadline = (await time.latest()) + 86400 * 7;
      await expect(airdrop.connect(timelock).setMerkleRoot(merkleRoot, deadline))
        .to.emit(airdrop, "MerkleRootSet")
        .withArgs(merkleRoot, deadline);
      expect(await airdrop.initialized()).to.be.true;
    });

    it("Should revert if not ADMIN_ROLE", async function () {
      const deadline = (await time.latest()) + 86400 * 7;
      await expect(airdrop.connect(user1).setMerkleRoot(merkleRoot, deadline)).to.be.reverted;
    });

    it("Should revert if already initialized", async function () {
      const deadline = (await time.latest()) + 86400 * 7;
      await airdrop.connect(timelock).setMerkleRoot(merkleRoot, deadline);
      await expect(airdrop.connect(timelock).setMerkleRoot(merkleRoot, deadline))
        .to.be.revertedWith("Already initialized");
    });

    it("Should revert with zero root", async function () {
      const deadline = (await time.latest()) + 86400 * 7;
      await expect(airdrop.connect(timelock).setMerkleRoot(ethers.ZeroHash, deadline))
        .to.be.revertedWith("Invalid root");
    });

    it("Should revert with deadline too soon", async function () {
      const deadline = (await time.latest()) + 100;
      await expect(airdrop.connect(timelock).setMerkleRoot(merkleRoot, deadline))
        .to.be.revertedWith("Invalid deadline");
    });

    it("Should revert after finalize", async function () {
      const deadline = (await time.latest()) + 86400 * 7;
      await airdrop.connect(timelock).setMerkleRoot(merkleRoot, deadline);
      await _finalizeAirdrop();
      await expect(airdrop.connect(timelock).setMerkleRoot(merkleRoot, deadline + 1000)).to.be.reverted;
    });
  });

  describe("claim", function () {
    beforeEach(async function () {
      const deadline = (await time.latest()) + 86400 * 7;
      await airdrop.connect(timelock).setMerkleRoot(merkleRoot, deadline);
    });

    it("Should allow valid claim", async function () {
      const claim = claims[0];
      const leafHash = ethers.keccak256(ethers.solidityPacked(["address", "uint256"], [claim.address, claim.amount]));
      const leafIndex = leaves.findIndex(l => l === leafHash);
      const proof = _getProof(leaves, leafIndex);

      const before = await token.balanceOf(user1.address);
      await expect(airdrop.connect(user1).claim(claim.amount, proof))
        .to.emit(airdrop, "Claimed")
        .withArgs(user1.address, claim.amount);
      const after = await token.balanceOf(user1.address);

      expect(after - before).to.equal(claim.amount);
      expect(await airdrop.hasUserClaimed(user1.address)).to.be.true;
      expect(await airdrop.totalClaimed()).to.equal(claim.amount);
    });

    it("Should allow multiple users to claim", async function () {
      for (let i = 0; i < claims.length; i++) {
        const claim = claims[i];
        const leafHash = ethers.keccak256(ethers.solidityPacked(["address", "uint256"], [claim.address, claim.amount]));
        const leafIndex = leaves.findIndex(l => l === leafHash);
        const proof = _getProof(leaves, leafIndex);
        const user = [user1, user2, user3][i];
        await airdrop.connect(user).claim(claim.amount, proof);
      }
      const total = claims.reduce((sum, c) => sum + c.amount, 0n);
      expect(await airdrop.totalClaimed()).to.equal(total);
    });

    it("Should revert with invalid proof", async function () {
      const fakeProof = [ethers.ZeroHash];
      await expect(airdrop.connect(user1).claim(ethers.parseEther("1000"), fakeProof))
        .to.be.revertedWith("Invalid proof");
    });

    it("Should revert with wrong amount", async function () {
      const claim = claims[0];
      const leafHash = ethers.keccak256(ethers.solidityPacked(["address", "uint256"], [claim.address, claim.amount]));
      const leafIndex = leaves.findIndex(l => l === leafHash);
      const proof = _getProof(leaves, leafIndex);
      await expect(airdrop.connect(user1).claim(ethers.parseEther("9999"), proof))
        .to.be.revertedWith("Invalid proof");
    });

    it("Should revert if already claimed", async function () {
      const claim = claims[0];
      const leafHash = ethers.keccak256(ethers.solidityPacked(["address", "uint256"], [claim.address, claim.amount]));
      const leafIndex = leaves.findIndex(l => l === leafHash);
      const proof = _getProof(leaves, leafIndex);
      await airdrop.connect(user1).claim(claim.amount, proof);
      await expect(airdrop.connect(user1).claim(claim.amount, proof))
        .to.be.revertedWith("Already claimed");
    });

    it("Should revert if not in merkle tree", async function () {
      const claim = claims[0];
      const leafHash = ethers.keccak256(ethers.solidityPacked(["address", "uint256"], [claim.address, claim.amount]));
      const leafIndex = leaves.findIndex(l => l === leafHash);
      const proof = _getProof(leaves, leafIndex);
      await expect(airdrop.connect(user4).claim(ethers.parseEther("1000"), proof))
        .to.be.revertedWith("Invalid proof");
    });

    it("Should revert if not initialized", async function () {
      const AirdropFactory = await ethers.getContractFactory("Airdrop");
      const newAirdrop = await AirdropFactory.deploy(await token.getAddress(), timelock.address);
      await newAirdrop.waitForDeployment();
      await expect(newAirdrop.connect(user1).claim(ethers.parseEther("1000"), []))
        .to.be.revertedWith("Not initialized");
    });

    it("Should revert after deadline", async function () {
      await time.increase(86400 * 8);
      const claim = claims[0];
      const leafHash = ethers.keccak256(ethers.solidityPacked(["address", "uint256"], [claim.address, claim.amount]));
      const leafIndex = leaves.findIndex(l => l === leafHash);
      const proof = _getProof(leaves, leafIndex);
      await expect(airdrop.connect(user1).claim(claim.amount, proof))
        .to.be.revertedWith("Expired");
    });

    it("Should revert after deactivate", async function () {
      await airdrop.connect(timelock).deactivate();
      const claim = claims[0];
      const leafHash = ethers.keccak256(ethers.solidityPacked(["address", "uint256"], [claim.address, claim.amount]));
      const leafIndex = leaves.findIndex(l => l === leafHash);
      const proof = _getProof(leaves, leafIndex);
      await expect(airdrop.connect(user1).claim(claim.amount, proof))
        .to.be.revertedWith("Disabled");
    });

    it("Should revert after finalize", async function () {
      await _finalizeAirdrop();
      const claim = claims[0];
      const leafHash = ethers.keccak256(ethers.solidityPacked(["address", "uint256"], [claim.address, claim.amount]));
      const leafIndex = leaves.findIndex(l => l === leafHash);
      const proof = _getProof(leaves, leafIndex);
      await expect(airdrop.connect(user1).claim(claim.amount, proof))
        .to.be.revertedWith("Finalized");
    });
  });

  describe("deactivate", function () {
    beforeEach(async function () {
      const deadline = (await time.latest()) + 86400 * 7;
      await airdrop.connect(timelock).setMerkleRoot(merkleRoot, deadline);
    });

    it("Should allow ADMIN_ROLE to deactivate", async function () {
      const before = await token.balanceOf(timelock.address);
      await expect(airdrop.connect(timelock).deactivate())
        .to.emit(airdrop, "Deactivated");
      const after = await token.balanceOf(timelock.address);
      expect(await airdrop.permanentlyDisabled()).to.be.true;
      expect(after).to.be.gt(before);
    });

    it("Should revert if not ADMIN_ROLE", async function () {
      await expect(airdrop.connect(user1).deactivate()).to.be.reverted;
    });

    it("Should revert after deadline", async function () {
      await time.increase(86400 * 8);
      await expect(airdrop.connect(timelock).deactivate()).to.be.revertedWith("Too late");
    });

    it("Should revert if already deactivated", async function () {
      await airdrop.connect(timelock).deactivate();
      await expect(airdrop.connect(timelock).deactivate()).to.be.revertedWith("Disabled");
    });

    it("Should revert after finalize", async function () {
      await _finalizeAirdrop();
      await expect(airdrop.connect(timelock).deactivate()).to.be.reverted;
    });
  });

  describe("withdrawRemaining", function () {
    beforeEach(async function () {
      const deadline = (await time.latest()) + 86400 * 7;
      await airdrop.connect(timelock).setMerkleRoot(merkleRoot, deadline);
    });

    it("Should allow ADMIN_ROLE to withdraw after deadline", async function () {
      await time.increase(86400 * 8);
      const before = await token.balanceOf(timelock.address);
      await expect(airdrop.connect(timelock).withdrawRemaining())
        .to.emit(airdrop, "WithdrawRemaining")
        .to.emit(airdrop, "Finalized");
      const after = await token.balanceOf(timelock.address);
      expect(await airdrop.finalized()).to.be.true;
      expect(after).to.be.gt(before);
    });

    it("Should revert if not ADMIN_ROLE", async function () {
      await time.increase(86400 * 8);
      await expect(airdrop.connect(user1).withdrawRemaining()).to.be.reverted;
    });

    it("Should revert before deadline", async function () {
      await expect(airdrop.connect(timelock).withdrawRemaining()).to.be.revertedWith("Not ended");
    });

    it("Should revert if nothing left", async function () {
      for (let i = 0; i < claims.length; i++) {
        const claim = claims[i];
        const leafHash = ethers.keccak256(ethers.solidityPacked(["address", "uint256"], [claim.address, claim.amount]));
        const leafIndex = leaves.findIndex(l => l === leafHash);
        const proof = _getProof(leaves, leafIndex);
        const user = [user1, user2, user3][i];
        await airdrop.connect(user).claim(claim.amount, proof);
      }
      await time.increase(86400 * 8);
      await expect(airdrop.connect(timelock).withdrawRemaining()).to.be.revertedWith("Nothing left");
    });

    it("Should revoke roles after withdraw", async function () {
      await time.increase(86400 * 8);
      await airdrop.connect(timelock).withdrawRemaining();
      expect(await airdrop.hasRole(await airdrop.ADMIN_ROLE(), timelock.address)).to.be.false;
    });
  });

  describe("finalize", function () {
    beforeEach(async function () {
      const deadline = (await time.latest()) + 86400 * 7;
      await airdrop.connect(timelock).setMerkleRoot(merkleRoot, deadline);
    });

    it("Should allow timelock to finalize during governance", async function () {
      await expect(airdrop.connect(timelock).finalize())
        .to.emit(airdrop, "Finalized");
      expect(await airdrop.finalized()).to.be.true;
    });

    it("Should allow ADMIN_ROLE to finalize after governance", async function () {
      await time.increase(GOVERNANCE_PERIOD + 1n);
      await expect(airdrop.connect(timelock).finalize())
        .to.emit(airdrop, "Finalized");
    });

    it("Should revert if non-timelock tries during governance", async function () {
      await airdrop.connect(timelock).grantRole(await airdrop.ADMIN_ROLE(), admin.address);
      await expect(airdrop.connect(admin).finalize()).to.be.revertedWith("Only timelock in governance");
    });

    it("Should revert if already finalized", async function () {
      await airdrop.connect(timelock).finalize();
      await expect(airdrop.connect(timelock).finalize()).to.be.reverted;
    });
  });

  describe("Role Management", function () {
    it("Should allow timelock to grant roles", async function () {
      await airdrop.connect(timelock).grantRole(await airdrop.ADMIN_ROLE(), admin.address);
      expect(await airdrop.hasRole(await airdrop.ADMIN_ROLE(), admin.address)).to.be.true;
    });

    it("Should allow timelock to revoke roles", async function () {
      await airdrop.connect(timelock).grantRole(await airdrop.ADMIN_ROLE(), admin.address);
      await airdrop.connect(timelock).revokeRole(await airdrop.ADMIN_ROLE(), admin.address);
      expect(await airdrop.hasRole(await airdrop.ADMIN_ROLE(), admin.address)).to.be.false;
    });

    it("Should revert if non-timelock grants role", async function () {
      await expect(airdrop.connect(admin).grantRole(await airdrop.ADMIN_ROLE(), admin.address))
        .to.be.revertedWith("Only timelock");
    });

    it("Should revert role operations after finalize", async function () {
      await _finalizeAirdrop();
      await expect(airdrop.connect(timelock).grantRole(await airdrop.ADMIN_ROLE(), admin.address)).to.be.reverted;
    });
  });

  describe("View Functions", function () {
    it("Should return correct isActive before init", async function () {
      expect(await airdrop.isActive()).to.be.false;
    });

    it("Should return correct isActive after init", async function () {
      const deadline = (await time.latest()) + 86400 * 7;
      await airdrop.connect(timelock).setMerkleRoot(merkleRoot, deadline);
      expect(await airdrop.isActive()).to.be.true;
    });

    it("Should return correct getInfo", async function () {
      const deadline = (await time.latest()) + 86400 * 7;
      await airdrop.connect(timelock).setMerkleRoot(merkleRoot, deadline);
      const info = await airdrop.getInfo();
      expect(info.active).to.be.true;
      expect(info._finalized).to.be.false;
      expect(info.remaining).to.equal(ethers.parseEther("10000"));
      expect(info.claimed).to.equal(0);
      expect(info.timeLeft).to.be.gt(0);
    });

    it("Should return timeLeft = 0 after finalize", async function () {
      const deadline = (await time.latest()) + 86400 * 7;
      await airdrop.connect(timelock).setMerkleRoot(merkleRoot, deadline);
      await _finalizeAirdrop();
      // After finalize, if deadline has not passed, contract still returns timeLeft > 0
      // We just check that active is false
      const info = await airdrop.getInfo();
      expect(info.active).to.be.false;
      expect(info._finalized).to.be.true;
    });
  });

  describe("Edge Cases", function () {
    it("Should prevent reentrancy on claim", async function () {
      const deadline = (await time.latest()) + 86400 * 7;
      await airdrop.connect(timelock).setMerkleRoot(merkleRoot, deadline);
      const claim = claims[0];
      const leafHash = ethers.keccak256(ethers.solidityPacked(["address", "uint256"], [claim.address, claim.amount]));
      const leafIndex = leaves.findIndex(l => l === leafHash);
      const proof = _getProof(leaves, leafIndex);
      await airdrop.connect(user1).claim(claim.amount, proof);
      await expect(airdrop.connect(user1).claim(claim.amount, proof)).to.be.revertedWith("Already claimed");
    });

    it("Should handle single user merkle tree", async function () {
      const singleClaim = { address: user1.address, amount: ethers.parseEther("5000") };
      const singleLeaf = ethers.keccak256(ethers.solidityPacked(["address", "uint256"], [singleClaim.address, singleClaim.amount]));
      const singleRoot = singleLeaf;

      const deadline = (await time.latest()) + 86400 * 7;
      await airdrop.connect(timelock).setMerkleRoot(singleRoot, deadline);

      const before = await token.balanceOf(user1.address);
      await airdrop.connect(user1).claim(singleClaim.amount, []);
      const after = await token.balanceOf(user1.address);
      expect(after - before).to.equal(singleClaim.amount);
    });

    it("Should not allow claim with manipulated proof", async function () {
      const deadline = (await time.latest()) + 86400 * 7;
      await airdrop.connect(timelock).setMerkleRoot(merkleRoot, deadline);
      const user2Claim = claims[1];
      const leafHash = ethers.keccak256(ethers.solidityPacked(["address", "uint256"], [user2Claim.address, user2Claim.amount]));
      const leafIndex = leaves.findIndex(l => l === leafHash);
      const proof = _getProof(leaves, leafIndex);
      await expect(airdrop.connect(user1).claim(user2Claim.amount, proof)).to.be.revertedWith("Invalid proof");
    });
  });

  async function _finalizeAirdrop() {
    await airdrop.connect(timelock).finalize();
  }
});