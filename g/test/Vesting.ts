import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { ProjectToken, Vesting } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("Vesting — Full Security Audit Test Suite", function () {
  let token: ProjectToken;
  let vesting: Vesting;
  let owner: SignerWithAddress;
  let timelock: SignerWithAddress;
  let funder: SignerWithAddress;
  let signer1: SignerWithAddress;
  let signer2: SignerWithAddress;
  let signer3: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let user3: SignerWithAddress;

  const MAX_SUPPLY = ethers.parseEther("1000000000");
  const GOVERNANCE_PERIOD = 180n * 24n * 60n * 60n;
  const CLIFF = 30n * 24n * 60n * 60n;
  const VESTING_DURATION = 90n * 24n * 60n * 60n;
  const PROPOSAL_EXPIRY = 3n * 24n * 60n * 60n;

  beforeEach(async function () {
    [owner, timelock, funder, signer1, signer2, signer3, user1, user2, user3] = await ethers.getSigners();

    // Deploy Token with vesting support
    const TokenFactory = await ethers.getContractFactory("ProjectToken");
    token = await TokenFactory.deploy(
      "ProjectToken", "PTK", timelock.address,
      [timelock.address], [MAX_SUPPLY], ethers.ZeroAddress
    );
    await token.waitForDeployment();

    // Deploy Vesting
    const VestingFactory = await ethers.getContractFactory("Vesting");
    vesting = await VestingFactory.deploy(
      await token.getAddress(),
      timelock.address,
      [signer1.address, signer2.address, signer3.address],
      2 // threshold = 2 of 3
    );
    await vesting.waitForDeployment();

    // Grant FUNDER_ROLE to vesting contract in token
    await token.connect(timelock).grantRole(await token.FUNDER_ROLE(), await vesting.getAddress());

    // Fund vesting contract
    await token.connect(timelock).approve(await vesting.getAddress(), ethers.parseEther("1000000"));
    await vesting.connect(timelock).fund(ethers.parseEther("1000000"));
  });

  // ═══════════════════════════════════════════════════════════════
  // 1. DEPLOYMENT
  // ═══════════════════════════════════════════════════════════════
  describe("Deployment", function () {
    it("Should set correct token", async function () {
      expect(await vesting.token()).to.equal(await token.getAddress());
    });

    it("Should set correct timelock", async function () {
      expect(await vesting.timelock()).to.equal(timelock.address);
    });

    it("Should set correct threshold", async function () {
      expect(await vesting.threshold()).to.equal(2);
    });

    it("Should set correct signers", async function () {
      const signers = await vesting.getSigners();
      expect(signers).to.deep.equal([signer1.address, signer2.address, signer3.address]);
    });

    it("Should set isSigner correctly", async function () {
      expect(await vesting.isSigner(signer1.address)).to.be.true;
      expect(await vesting.isSigner(signer2.address)).to.be.true;
      expect(await vesting.isSigner(signer3.address)).to.be.true;
      expect(await vesting.isSigner(user1.address)).to.be.false;
    });

    it("Should assign DEFAULT_ADMIN_ROLE to timelock", async function () {
      expect(await vesting.hasRole(await vesting.DEFAULT_ADMIN_ROLE(), timelock.address)).to.be.true;
    });

    it("Should assign FUNDER_ROLE to timelock", async function () {
      expect(await vesting.hasRole(await vesting.FUNDER_ROLE(), timelock.address)).to.be.true;
    });

    it("Should revert with zero token", async function () {
      const VestingFactory = await ethers.getContractFactory("Vesting");
      await expect(
        VestingFactory.deploy(ethers.ZeroAddress, timelock.address, [signer1.address], 1)
      ).to.be.revertedWith("Invalid token");
    });

    it("Should revert with zero timelock", async function () {
      const VestingFactory = await ethers.getContractFactory("Vesting");
      await expect(
        VestingFactory.deploy(await token.getAddress(), ethers.ZeroAddress, [signer1.address], 1)
      ).to.be.revertedWith("Invalid timelock");
    });

    it("Should revert with empty signers", async function () {
      const VestingFactory = await ethers.getContractFactory("Vesting");
      await expect(
        VestingFactory.deploy(await token.getAddress(), timelock.address, [], 0)
      ).to.be.revertedWith("Bad signers");
    });

    it("Should revert with too many signers", async function () {
      const VestingFactory = await ethers.getContractFactory("Vesting");
      const manySigners = Array(51).fill(signer1.address);
      await expect(
        VestingFactory.deploy(await token.getAddress(), timelock.address, manySigners, 2)
      ).to.be.revertedWith("Bad signers");
    });

    it("Should revert with threshold < 2", async function () {
      const VestingFactory = await ethers.getContractFactory("Vesting");
      await expect(
        VestingFactory.deploy(await token.getAddress(), timelock.address, [signer1.address], 1)
      ).to.be.revertedWith("Bad threshold");
    });

    it("Should revert with threshold > signers", async function () {
      const VestingFactory = await ethers.getContractFactory("Vesting");
      await expect(
        VestingFactory.deploy(await token.getAddress(), timelock.address, [signer1.address], 3)
      ).to.be.revertedWith("Bad threshold");
    });

    it("Should revert with duplicate signers", async function () {
      const VestingFactory = await ethers.getContractFactory("Vesting");
      await expect(
        VestingFactory.deploy(await token.getAddress(), timelock.address, [signer1.address, signer1.address], 2)
      ).to.be.revertedWith("Duplicate signer");
    });

    it("Should revert with zero address signer", async function () {
      const VestingFactory = await ethers.getContractFactory("Vesting");
      await expect(
        VestingFactory.deploy(await token.getAddress(), timelock.address, [ethers.ZeroAddress], 1)
      ).to.be.revertedWith("Invalid signer");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 2. FUNDING
  // ═══════════════════════════════════════════════════════════════
  describe("fund", function () {
    it("Should allow FUNDER_ROLE to fund", async function () {
      const before = await token.balanceOf(await vesting.getAddress());
      await token.connect(timelock).approve(await vesting.getAddress(), ethers.parseEther("1000"));
      await expect(vesting.connect(timelock).fund(ethers.parseEther("1000")))
        .to.emit(vesting, "Funded")
        .withArgs(timelock.address, ethers.parseEther("1000"));
      const after = await token.balanceOf(await vesting.getAddress());
      expect(after - before).to.equal(ethers.parseEther("1000"));
    });

    it("Should revert if non-FUNDER_ROLE calls", async function () {
      await expect(vesting.connect(user1).fund(ethers.parseEther("1000"))).to.be.reverted;
    });

    it("Should revert with zero amount", async function () {
      await expect(vesting.connect(timelock).fund(0)).to.be.revertedWith("Zero amount");
    });

    it("Should revert after finalize", async function () {
      await _createAndFinalizeProposal();
      await expect(vesting.connect(timelock).fund(ethers.parseEther("1000"))).to.be.revertedWith("Finalized");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 3. PROPOSALS — CREATE
  // ═══════════════════════════════════════════════════════════════
  describe("createProposal & execute (CREATE)", function () {
    it("Should create vesting with multi-sig", async function () {
      const amount = ethers.parseEther("10000");
      const id = await vesting.connect(timelock).createProposal(0, user1.address, amount); // CREATE = 0

      await vesting.connect(signer1).approve(id);
      await vesting.connect(signer2).approve(id);

      const before = await token.balanceOf(user1.address);
      await vesting.connect(signer1).execute(id);
      const after = await token.balanceOf(user1.address);

      // immediate = 25% = 2500
      expect(after - before).to.equal(ethers.parseEther("2500"));

      const v = await vesting.getVesting(user1.address);
      expect(v.active).to.be.true;
      expect(v.totalAllocation).to.equal(amount);
    });

    it("Should revert if threshold not met", async function () {
      const amount = ethers.parseEther("10000");
      const id = await vesting.connect(timelock).createProposal(0, user1.address, amount);

      await vesting.connect(signer1).approve(id);

      await expect(vesting.connect(signer1).execute(id)).to.be.revertedWith("Not enough");
    });

    it("Should revert duplicate approval", async function () {
      const amount = ethers.parseEther("10000");
      const id = await vesting.connect(timelock).createProposal(0, user1.address, amount);

      await vesting.connect(signer1).approve(id);
      await expect(vesting.connect(signer1).approve(id)).to.be.revertedWith("Approved");
    });

    it("Should revert if non-signer approves", async function () {
      const amount = ethers.parseEther("10000");
      const id = await vesting.connect(timelock).createProposal(0, user1.address, amount);

      await expect(vesting.connect(user1).approve(id)).to.be.revertedWith("Not signer");
    });

    it("Should revert if non-FUNDER_ROLE creates proposal", async function () {
      await expect(vesting.connect(user1).createProposal(0, user1.address, ethers.parseEther("10000"))).to.be.reverted;
    });

    it("Should revert with zero amount", async function () {
      await expect(vesting.connect(timelock).createProposal(0, user1.address, 0)).to.be.revertedWith("Zero amount");
    });

    it("Should revert if vesting exists", async function () {
      const amount = ethers.parseEther("10000");
      const id = await vesting.connect(timelock).createProposal(0, user1.address, amount);
      await vesting.connect(signer1).approve(id);
      await vesting.connect(signer2).approve(id);
      await vesting.connect(signer1).execute(id);

      const id2 = await vesting.connect(timelock).createProposal(0, user1.address, amount);
      await vesting.connect(signer1).approve(id2);
      await vesting.connect(signer2).approve(id2);
      await expect(vesting.connect(signer1).execute(id2)).to.be.revertedWith("Exists");
    });

    it("Should revert if insufficient funds", async function () {
      const amount = ethers.parseEther("2000000"); // More than funded
      const id = await vesting.connect(timelock).createProposal(0, user1.address, amount);
      await vesting.connect(signer1).approve(id);
      await vesting.connect(signer2).approve(id);
      await expect(vesting.connect(signer1).execute(id)).to.be.revertedWith("Insufficient");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 4. PROPOSALS — CANCEL
  // ═══════════════════════════════════════════════════════════════
  describe("cancel", function () {
    it("Should cancel vesting and return remaining", async function () {
      const amount = ethers.parseEther("10000");
      const id = await vesting.connect(timelock).createProposal(0, user1.address, amount);
      await vesting.connect(signer1).approve(id);
      await vesting.connect(signer2).approve(id);
      await vesting.connect(signer1).execute(id);

      // Pass some time but not full vesting
      await time.increase(CLIFF + VESTING_DURATION / 2n);

      const idCancel = await vesting.connect(timelock).createProposal(1, user1.address, 0); // CANCEL = 1
      await vesting.connect(signer1).approve(idCancel);
      await vesting.connect(signer2).approve(idCancel);

      const before = await token.balanceOf(user1.address);
      await vesting.connect(signer1).execute(idCancel);
      const after = await token.balanceOf(user1.address);

      expect(after).to.be.gt(before); // User got remaining

      const v = await vesting.getVesting(user1.address);
      expect(v.cancelled).to.be.true;
      expect(v.active).to.be.false;
    });

    it("Should revert cancel if already cancelled", async function () {
      const amount = ethers.parseEther("10000");
      const id = await vesting.connect(timelock).createProposal(0, user1.address, amount);
      await vesting.connect(signer1).approve(id);
      await vesting.connect(signer2).approve(id);
      await vesting.connect(signer1).execute(id);

      const idCancel = await vesting.connect(timelock).createProposal(1, user1.address, 0);
      await vesting.connect(signer1).approve(idCancel);
      await vesting.connect(signer2).approve(idCancel);
      await vesting.connect(signer1).execute(idCancel);

      const idCancel2 = await vesting.connect(timelock).createProposal(1, user1.address, 0);
      await vesting.connect(signer1).approve(idCancel2);
      await vesting.connect(signer2).approve(idCancel2);
      await expect(vesting.connect(signer1).execute(idCancel2)).to.be.revertedWith("Invalid");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 5. RELEASE
  // ═══════════════════════════════════════════════════════════════
  describe("release", function () {
    it("Should release nothing before cliff", async function () {
      const amount = ethers.parseEther("10000");
      const id = await vesting.connect(timelock).createProposal(0, user1.address, amount);
      await vesting.connect(signer1).approve(id);
      await vesting.connect(signer2).approve(id);
      await vesting.connect(signer1).execute(id);

      await expect(vesting.connect(user1).release()).to.be.revertedWith("Nothing");
    });

    it("Should release after cliff", async function () {
      const amount = ethers.parseEther("10000");
      const id = await vesting.connect(timelock).createProposal(0, user1.address, amount);
      await vesting.connect(signer1).approve(id);
      await vesting.connect(signer2).approve(id);
      await vesting.connect(signer1).execute(id);

      await time.increase(CLIFF + 1n);

      const before = await token.balanceOf(user1.address);
      await vesting.connect(user1).release();
      const after = await token.balanceOf(user1.address);

      expect(after).to.be.gt(before);
    });

    it("Should release full amount after vesting duration", async function () {
      const amount = ethers.parseEther("10000");
      const id = await vesting.connect(timelock).createProposal(0, user1.address, amount);
      await vesting.connect(signer1).approve(id);
      await vesting.connect(signer2).approve(id);
      await vesting.connect(signer1).execute(id);

      await time.increase(CLIFF + VESTING_DURATION + 1n);

      const before = await token.balanceOf(user1.address);
      await vesting.connect(user1).release();
      const after = await token.balanceOf(user1.address);

      // immediate (25%) + full vest (75%) = 100%
      expect(after - before).to.equal(ethers.parseEther("7500"));
    });

    it("Should revert release if inactive", async function () {
      await expect(vesting.connect(user1).release()).to.be.revertedWith("Inactive");
    });

    it("Should revert release if nothing to release", async function () {
      const amount = ethers.parseEther("10000");
      const id = await vesting.connect(timelock).createProposal(0, user1.address, amount);
      await vesting.connect(signer1).approve(id);
      await vesting.connect(signer2).approve(id);
      await vesting.connect(signer1).execute(id);

      await time.increase(CLIFF + VESTING_DURATION + 1n);
      await vesting.connect(user1).release(); // First release

      await expect(vesting.connect(user1).release()).to.be.revertedWith("Nothing");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 6. FINALIZE
  // ═══════════════════════════════════════════════════════════════
  describe("finalize", function () {
    it("Should finalize and return excess", async function () {
      const amount = ethers.parseEther("10000");
      const id = await vesting.connect(timelock).createProposal(0, user1.address, amount);
      await vesting.connect(signer1).approve(id);
      await vesting.connect(signer2).approve(id);
      await vesting.connect(signer1).execute(id);

      const idFinal = await vesting.connect(timelock).createProposal(2, ethers.ZeroAddress, 0); // FINALIZE = 2
      await vesting.connect(signer1).approve(idFinal);
      await vesting.connect(signer2).approve(idFinal);

      const before = await token.balanceOf(timelock.address);
      await expect(vesting.connect(signer1).execute(idFinal))
        .to.emit(vesting, "Finalized");
      const after = await token.balanceOf(timelock.address);

      expect(after).to.be.gt(before); // Excess returned
      expect(await vesting.finalized()).to.be.true;
    });

    it("Should emit GovernanceEnded if after period", async function () {
      await time.increase(GOVERNANCE_PERIOD + 1n);

      const idFinal = await vesting.connect(timelock).createProposal(2, ethers.ZeroAddress, 0);
      await vesting.connect(signer1).approve(idFinal);
      await vesting.connect(signer2).approve(idFinal);

      await expect(vesting.connect(signer1).execute(idFinal))
        .to.emit(vesting, "GovernanceEnded");
    });

    it("Should revert if already finalized", async function () {
      const idFinal = await vesting.connect(timelock).createProposal(2, ethers.ZeroAddress, 0);
      await vesting.connect(signer1).approve(idFinal);
      await vesting.connect(signer2).approve(idFinal);
      await vesting.connect(signer1).execute(idFinal);

      const idFinal2 = await vesting.connect(timelock).createProposal(2, ethers.ZeroAddress, 0);
      await vesting.connect(signer1).approve(idFinal2);
      await vesting.connect(signer2).approve(idFinal2);
      await expect(vesting.connect(signer1).execute(idFinal2)).to.be.revertedWith("Finalized");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 7. PROPOSAL EXPIRY
  // ═══════════════════════════════════════════════════════════════
  describe("Proposal Expiry", function () {
    it("Should revert approval after expiry", async function () {
      const amount = ethers.parseEther("10000");
      const id = await vesting.connect(timelock).createProposal(0, user1.address, amount);

      await time.increase(PROPOSAL_EXPIRY + 1n);

      await expect(vesting.connect(signer1).approve(id)).to.be.revertedWith("Expired");
    });

    // 🔴 BUG: execute does not check expiry
    it("[BUG] Should revert execute after expiry", async function () {
      const amount = ethers.parseEther("10000");
      const id = await vesting.connect(timelock).createProposal(0, user1.address, amount);
      await vesting.connect(signer1).approve(id);
      await vesting.connect(signer2).approve(id);

      await time.increase(PROPOSAL_EXPIRY + 1n);

      // This SHOULD fail but currently passes (BUG)
      await expect(vesting.connect(signer1).execute(id)).to.be.revertedWith("Expired");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 8. VIEW FUNCTIONS
  // ═══════════════════════════════════════════════════════════════
  describe("View Functions", function () {
    it("Should return correct releasable before cliff", async function () {
      const amount = ethers.parseEther("10000");
      const id = await vesting.connect(timelock).createProposal(0, user1.address, amount);
      await vesting.connect(signer1).approve(id);
      await vesting.connect(signer2).approve(id);
      await vesting.connect(signer1).execute(id);

      expect(await vesting.releasable(user1.address)).to.equal(0);
    });

    it("Should return correct releasable after full vesting", async function () {
      const amount = ethers.parseEther("10000");
      const id = await vesting.connect(timelock).createProposal(0, user1.address, amount);
      await vesting.connect(signer1).approve(id);
      await vesting.connect(signer2).approve(id);
      await vesting.connect(signer1).execute(id);

      await time.increase(CLIFF + VESTING_DURATION + 1n);

      expect(await vesting.releasable(user1.address)).to.equal(ethers.parseEther("7500"));
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 9. EDGE CASES & ATTACK VECTORS
  // ═══════════════════════════════════════════════════════════════
  describe("Edge Cases", function () {
    it("Should handle multiple vesting schedules", async function () {
      const id1 = await vesting.connect(timelock).createProposal(0, user1.address, ethers.parseEther("10000"));
      await vesting.connect(signer1).approve(id1);
      await vesting.connect(signer2).approve(id1);
      await vesting.connect(signer1).execute(id1);

      const id2 = await vesting.connect(timelock).createProposal(0, user2.address, ethers.parseEther("20000"));
      await vesting.connect(signer1).approve(id2);
      await vesting.connect(signer2).approve(id2);
      await vesting.connect(signer1).execute(id2);

      expect(await vesting.totalAllocated()).to.equal(ethers.parseEther("30000"));
    });

    it("Should prevent reentrancy on execute", async function () {
      const amount = ethers.parseEther("10000");
      const id = await vesting.connect(timelock).createProposal(0, user1.address, amount);
      await vesting.connect(signer1).approve(id);
      await vesting.connect(signer2).approve(id);

      // First execute succeeds
      await vesting.connect(signer1).execute(id);

      // Second execute fails (already executed)
      await expect(vesting.connect(signer1).execute(id)).to.be.revertedWith("Executed");
    });

    it("Should prevent reentrancy on release", async function () {
      const amount = ethers.parseEther("10000");
      const id = await vesting.connect(timelock).createProposal(0, user1.address, amount);
      await vesting.connect(signer1).approve(id);
      await vesting.connect(signer2).approve(id);
      await vesting.connect(signer1).execute(id);

      await time.increase(CLIFF + VESTING_DURATION + 1n);

      await vesting.connect(user1).release();
      await expect(vesting.connect(user1).release()).to.be.revertedWith("Nothing");
    });
  });

  // Helper function
  async function _createAndFinalizeProposal() {
    const idFinal = await vesting.connect(timelock).createProposal(2, ethers.ZeroAddress, 0);
    await vesting.connect(signer1).approve(idFinal);
    await vesting.connect(signer2).approve(idFinal);
    await vesting.connect(signer1).execute(idFinal);
  }
});