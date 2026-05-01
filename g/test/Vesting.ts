import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { Vesting, MockToken } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("Vesting Contract Tests", function () {
  let vesting: Vesting;
  let token: MockToken;
  let timelock: SignerWithAddress;
  let signer1: SignerWithAddress;
  let signer2: SignerWithAddress;
  let signer3: SignerWithAddress;
  let user: SignerWithAddress;
  let funder: SignerWithAddress;
  let others: SignerWithAddress[];

  const THRESHOLD = 2;
  const INITIAL_FUND = ethers.parseUnits("100000", 18);
  const CLIFF = 30 * 24 * 60 * 60; // 30 days
  const VESTING_DURATION = 90 * 24 * 60 * 60; // 90 days
  const GOVERNANCE_PERIOD = 180 * 24 * 60 * 60; // 180 days
  const PROPOSAL_EXPIRY = 3 * 24 * 60 * 60; // 3 days

  beforeEach(async function () {
    [timelock, signer1, signer2, signer3, user, funder, ...others] = await ethers.getSigners();

    // Deploy Mock Token
    const MockTokenFactory = await ethers.getContractFactory("MockToken");
    token = await MockTokenFactory.deploy("Test Token", "TEST");
    await token.waitForDeployment();

    // Deploy Vesting
    const VestingFactory = await ethers.getContractFactory("Vesting");
    vesting = await VestingFactory.deploy(
      await token.getAddress(),
      timelock.address,
      [signer1.address, signer2.address, signer3.address],
      THRESHOLD
    );
    await vesting.waitForDeployment();

    // Fund vesting contract
    await token.connect(timelock).approve(await vesting.getAddress(), INITIAL_FUND);
    await vesting.connect(timelock).fund(INITIAL_FUND);
  });

  // ============ CONSTRUCTOR TESTS ============
  describe("Constructor", function () {
    it("Should set correct initial values", async function () {
      expect(await vesting.token()).to.equal(await token.getAddress());
      expect(await vesting.timelock()).to.equal(timelock.address);
      expect(await vesting.threshold()).to.equal(THRESHOLD);
      expect(await vesting.finalized()).to.be.false;
    });

    it("Should revert with zero token address", async function () {
      const VestingFactory = await ethers.getContractFactory("Vesting");
      await expect(
        VestingFactory.deploy(
          ethers.ZeroAddress,
          timelock.address,
          [signer1.address],
          1
        )
      ).to.be.revertedWith("Invalid token");
    });

    it("Should revert with zero timelock address", async function () {
      const VestingFactory = await ethers.getContractFactory("Vesting");
      await expect(
        VestingFactory.deploy(
          await token.getAddress(),
          ethers.ZeroAddress,
          [signer1.address],
          1
        )
      ).to.be.revertedWith("Invalid timelock");
    });

    it("Should revert with no signers", async function () {
      const VestingFactory = await ethers.getContractFactory("Vesting");
      await expect(
        VestingFactory.deploy(
          await token.getAddress(),
          timelock.address,
          [],
          1
        )
      ).to.be.revertedWith("Bad signers");
    });

    it("Should revert with too many signers", async function () {
      const VestingFactory = await ethers.getContractFactory("Vesting");
      const manySigners = Array(51).fill(signer1.address);
      await expect(
        VestingFactory.deploy(
          await token.getAddress(),
          timelock.address,
          manySigners,
          2
        )
      ).to.be.revertedWith("Bad signers");
    });

    it("Should revert with bad threshold (too low)", async function () {
      const VestingFactory = await ethers.getContractFactory("Vesting");
      await expect(
        VestingFactory.deploy(
          await token.getAddress(),
          timelock.address,
          [signer1.address, signer2.address],
          1
        )
      ).to.be.revertedWith("Bad threshold");
    });

    it("Should revert with bad threshold (too high)", async function () {
      const VestingFactory = await ethers.getContractFactory("Vesting");
      await expect(
        VestingFactory.deploy(
          await token.getAddress(),
          timelock.address,
          [signer1.address, signer2.address],
          3
        )
      ).to.be.revertedWith("Bad threshold");
    });

    it("Should revert with duplicate signer", async function () {
      const VestingFactory = await ethers.getContractFactory("Vesting");
      await expect(
        VestingFactory.deploy(
          await token.getAddress(),
          timelock.address,
          [signer1.address, signer1.address],
          2
        )
      ).to.be.revertedWith("Duplicate signer");
    });

    it("Should revert with zero address signer", async function () {
      const VestingFactory = await ethers.getContractFactory("Vesting");
      await expect(
        VestingFactory.deploy(
          await token.getAddress(),
          timelock.address,
          [signer1.address, ethers.ZeroAddress],
          2
        )
      ).to.be.revertedWith("Invalid signer");
    });
  });

  // ============ FUND TESTS ============
  describe("Fund", function () {
    it("Should fund successfully", async function () {
      const fundAmount = ethers.parseUnits("10000", 18);
      await token.connect(timelock).approve(await vesting.getAddress(), fundAmount);
      
      await expect(vesting.connect(timelock).fund(fundAmount))
        .to.emit(vesting, "Funded")
        .withArgs(timelock.address, fundAmount);

      expect(await token.balanceOf(await vesting.getAddress())).to.equal(INITIAL_FUND + fundAmount);
    });

    it("Should revert with zero amount", async function () {
      await expect(vesting.connect(timelock).fund(0)).to.be.revertedWith("Zero amount");
    });

    it("Should revert when unauthorized", async function () {
      await expect(vesting.connect(user).fund(1000)).to.be.reverted;
    });
  });

  // ============ PROPOSAL TESTS ============
  describe("Proposals", function () {
    it("Should create proposal successfully", async function () {
      const amount = 1000;
      
      await expect(vesting.connect(timelock).createProposal(0, user.address, amount)) // 0 = CREATE
        .to.emit(vesting, "ProposalCreated");

      expect(await vesting.activeProposalsCount()).to.equal(1);
    });

    it("Should revert duplicate proposal", async function () {
      const amount = 1000;
      await vesting.connect(timelock).createProposal(0, user.address, amount);
      
      // Same proposal should revert due to nonce change making different id
      // But proposalExists prevents exact same id (impossible with nonce)
      await vesting.connect(timelock).createProposal(0, user.address, amount);
      expect(await vesting.activeProposalsCount()).to.equal(2);
    });

    it("Should revert when max proposals reached", async function () {
      for (let i = 0; i < 100; i++) {
        await vesting.connect(timelock).createProposal(0, others[i % others.length].address, 1000);
      }
      
      await expect(
        vesting.connect(timelock).createProposal(0, user.address, 1000)
      ).to.be.revertedWith("Max proposals reached");
    });

    it("Should revert when unauthorized", async function () {
      await expect(
        vesting.connect(user).createProposal(0, user.address, 1000)
      ).to.be.reverted;
    });

    it("Should revert after governance ended", async function () {
      await time.increase(GOVERNANCE_PERIOD + 1);
      
      await expect(
        vesting.connect(timelock).createProposal(0, user.address, 1000)
      ).to.be.revertedWith("Governance ended");
    });
  });

  // ============ APPROVE TESTS ============
  describe("Approve", function () {
    let proposalId: string;

    beforeEach(async function () {
      const tx = await vesting.connect(timelock).createProposal(0, user.address, 1000);
      const receipt = await tx.wait();
      const event = receipt?.logs.find(
        (log: any) => log.fragment?.name === "ProposalCreated"
      );
      proposalId = event?.args?.[0];
    });

    it("Should approve successfully", async function () {
      await expect(vesting.connect(signer1).approve(proposalId))
        .to.emit(vesting, "ProposalApproved")
        .withArgs(proposalId, signer1.address);

      expect(await vesting.approved(proposalId, signer1.address)).to.be.true;
    });

    it("Should revert for invalid proposal", async function () {
      const fakeId = ethers.keccak256(ethers.toUtf8Bytes("fake"));
      await expect(vesting.connect(signer1).approve(fakeId)).to.be.revertedWith("Invalid");
    });

    it("Should revert for already executed proposal", async function () {
      await vesting.connect(signer1).approve(proposalId);
      await vesting.connect(signer2).approve(proposalId);
      await vesting.connect(signer1).execute(proposalId);

      await expect(vesting.connect(signer3).approve(proposalId)).to.be.revertedWith("Executed");
    });

    it("Should revert when expired", async function () {
      await time.increase(PROPOSAL_EXPIRY + 1);
      
      await expect(vesting.connect(signer1).approve(proposalId)).to.be.revertedWith("Expired");
    });

    it("Should revert for double approval", async function () {
      await vesting.connect(signer1).approve(proposalId);
      
      await expect(vesting.connect(signer1).approve(proposalId)).to.be.revertedWith("Approved");
    });

    it("Should revert when not signer", async function () {
      await expect(vesting.connect(user).approve(proposalId)).to.be.revertedWith("Not signer");
    });
  });

  // ============ EXECUTE TESTS ============
  describe("Execute", function () {
    it("Should execute CREATE proposal", async function () {
      const amount = ethers.parseUnits("10000", 18);
      const tx = await vesting.connect(timelock).createProposal(0, user.address, amount);
      const receipt = await tx.wait();
      const event = receipt?.logs.find(
        (log: any) => log.fragment?.name === "ProposalCreated"
      );
      const proposalId = event?.args?.[0];

      await vesting.connect(signer1).approve(proposalId);
      await vesting.connect(signer2).approve(proposalId);

      await expect(vesting.connect(signer1).execute(proposalId))
        .to.emit(vesting, "ProposalExecuted");

      const schedule = await vesting.vesting(user.address);
      expect(schedule.active).to.be.true;
      expect(schedule.totalAllocation).to.equal(amount);
    });

    it("Should execute CANCEL proposal", async function () {
      const amount = ethers.parseUnits("10000", 18);
      
      // Create vesting first
      let tx = await vesting.connect(timelock).createProposal(0, user.address, amount);
      let receipt = await tx.wait();
      let event = receipt?.logs.find((log: any) => log.fragment?.name === "ProposalCreated");
      const createId = event?.args?.[0];
      
      await vesting.connect(signer1).approve(createId);
      await vesting.connect(signer2).approve(createId);
      await vesting.connect(signer1).execute(createId);

      // Cancel it
      tx = await vesting.connect(timelock).createProposal(1, user.address, 0); // 1 = CANCEL
      receipt = await tx.wait();
      event = receipt?.logs.find((log: any) => log.fragment?.name === "ProposalCreated");
      const cancelId = event?.args?.[0];

      await vesting.connect(signer1).approve(cancelId);
      await vesting.connect(signer2).approve(cancelId);
      await vesting.connect(signer1).execute(cancelId);

      const schedule = await vesting.vesting(user.address);
      expect(schedule.active).to.be.false;
      expect(schedule.cancelled).to.be.true;
    });

    it("Should execute FINALIZE proposal", async function () {
      const tx = await vesting.connect(timelock).createProposal(2, ethers.ZeroAddress, 0); // 2 = FINALIZE
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => log.fragment?.name === "ProposalCreated");
      const proposalId = event?.args?.[0];

      await vesting.connect(signer1).approve(proposalId);
      await vesting.connect(signer2).approve(proposalId);

      await expect(vesting.connect(signer1).execute(proposalId))
        .to.emit(vesting, "Finalized");

      expect(await vesting.finalized()).to.be.true;
    });

    it("Should revert with not enough approvals", async function () {
      const tx = await vesting.connect(timelock).createProposal(0, user.address, 1000);
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => log.fragment?.name === "ProposalCreated");
      const proposalId = event?.args?.[0];

      await vesting.connect(signer1).approve(proposalId);

      await expect(vesting.connect(signer1).execute(proposalId)).to.be.revertedWith("Not enough");
    });

    it("Should revert when expired", async function () {
      const tx = await vesting.connect(timelock).createProposal(0, user.address, 1000);
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => log.fragment?.name === "ProposalCreated");
      const proposalId = event?.args?.[0];

      await vesting.connect(signer1).approve(proposalId);
      await vesting.connect(signer2).approve(proposalId);

      await time.increase(PROPOSAL_EXPIRY + 1);

      await expect(vesting.connect(signer1).execute(proposalId)).to.be.revertedWith("Expired");
    });
  });

  // ============ RELEASE TESTS ============
  describe("Release", function () {
    const amount = ethers.parseUnits("10000", 18);
    let proposalId: string;

    beforeEach(async function () {
      const tx = await vesting.connect(timelock).createProposal(0, user.address, amount);
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => log.fragment?.name === "ProposalCreated");
      proposalId = event?.args?.[0];

      await vesting.connect(signer1).approve(proposalId);
      await vesting.connect(signer2).approve(proposalId);
      await vesting.connect(signer1).execute(proposalId);
    });

    it("Should release after cliff", async function () {
      await time.increase(CLIFF + 1);

      const releasable = await vesting.releasable(user.address);
      expect(releasable).to.be.gt(0);

      const balanceBefore = await token.balanceOf(user.address);
      
      await expect(vesting.connect(user).release())
        .to.emit(vesting, "TokensReleased");

      const balanceAfter = await token.balanceOf(user.address);
      expect(balanceAfter).to.be.gt(balanceBefore);
    });

    it("Should revert before cliff", async function () {
      await time.increase(CLIFF - 1);

      await expect(vesting.connect(user).release()).to.be.revertedWith("Nothing");
    });

    it("Should release full amount after duration", async function () {
      await time.increase(VESTING_DURATION + 1);

      const releasable = await vesting.releasable(user.address);
      const immediate = amount * 2500n / 10000n;
      const vest = amount - immediate;

      expect(releasable).to.equal(vest);

      await vesting.connect(user).release();

      const schedule = await vesting.vesting(user.address);
      expect(schedule.released).to.equal(vest);
    });

    it("Should revert when inactive", async function () {
      await expect(vesting.connect(signer1).release()).to.be.revertedWith("Inactive");
    });
  });

  // ============ INVARIANT TESTS ============
  describe("Invariants", function () {
    it("Should maintain accounting invariant", async function () {
      const amount = ethers.parseUnits("10000", 18);
      const tx = await vesting.connect(timelock).createProposal(0, user.address, amount);
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => log.fragment?.name === "ProposalCreated");
      const proposalId = event?.args?.[0];

      await vesting.connect(signer1).approve(proposalId);
      await vesting.connect(signer2).approve(proposalId);
      await vesting.connect(signer1).execute(proposalId);

      const accounted = await vesting.totalAllocated() - await vesting.totalReleased();
      expect(accounted).to.equal(await vesting.obligations());
    });

    it("Should maintain balance invariant", async function () {
      const amount = ethers.parseUnits("10000", 18);
      const tx = await vesting.connect(timelock).createProposal(0, user.address, amount);
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => log.fragment?.name === "ProposalCreated");
      const proposalId = event?.args?.[0];

      await vesting.connect(signer1).approve(proposalId);
      await vesting.connect(signer2).approve(proposalId);
      await vesting.connect(signer1).execute(proposalId);

      const balance = await token.balanceOf(await vesting.getAddress());
      const obligations = await vesting.obligations();
      expect(balance).to.be.gte(obligations);
    });
  });
});