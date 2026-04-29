import { ethers } from "hardhat";

async function checkContract() {
  const [owner, user1, user2] = await ethers.getSigners();
  
  const TokenFactory = await ethers.getContractFactory("ProjectToken");
  const token = await TokenFactory.deploy(
    "Test", "TST", owner.address,
    [user1.address, user2.address],
    [ethers.parseEther("500000000"), ethers.parseEther("500000000")]
  );
  await token.waitForDeployment();
  
  console.log("Contract deployed at:", await token.getAddress());
  
  // Check role admin
  const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE();
  const ADMIN_ROLE = await token.ADMIN_ROLE();
  const DEX_MANAGER_ROLE = await token.DEX_MANAGER_ROLE();
  
  console.log("\n=== ROLE ADMIN CHECK ===");
  console.log("DEFAULT_ADMIN_ROLE:", DEFAULT_ADMIN_ROLE);
  console.log("ADMIN_ROLE:", ADMIN_ROLE);
  console.log("DEX_MANAGER_ROLE:", DEX_MANAGER_ROLE);
  
  console.log("\nRole Admin for DEFAULT_ADMIN_ROLE:", await token.getRoleAdmin(DEFAULT_ADMIN_ROLE));
  console.log("Role Admin for ADMIN_ROLE:", await token.getRoleAdmin(ADMIN_ROLE));
  console.log("Role Admin for DEX_MANAGER_ROLE:", await token.getRoleAdmin(DEX_MANAGER_ROLE));
  
  console.log("\n=== TIMELOCK ROLES ===");
  console.log("Has DEFAULT_ADMIN_ROLE:", await token.hasRole(DEFAULT_ADMIN_ROLE, owner.address));
  console.log("Has ADMIN_ROLE:", await token.hasRole(ADMIN_ROLE, owner.address));
  console.log("Has DEX_MANAGER_ROLE:", await token.hasRole(DEX_MANAGER_ROLE, owner.address));
}

checkContract().catch(console.error);
