import { ethers } from "hardhat";

async function main() {
  // الحصول على الحساب الناشر
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying contracts with the account: ${deployer.address}`);

  // --- الإعدادات (Configurations) ---
  const timelock: string = deployer.address; // في الشبكة المحلية نستخدم المطور كـ timelock
  const tokenName: string = "My Project Token";
  const tokenSymbol: string = "MPT";
  
  // توزيع المليار توكن بالكامل للمطور (أو تقسيمها حسب الحاجة)
  const recipients: string[] = [deployer.address];
  const amounts: bigint[] = [ethers.parseUnits("1000000000", 18)];
  
  // إعدادات الـ Vesting (الموقعين والحد الأدنى)
  const signers: string[] = [
    deployer.address,
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", // Account #1 في Hardhat
    "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"  // Account #2 في Hardhat
  ];
  const threshold: number = 2;

  console.log("\n--- Starting Deployment ---\n");

  // 1. نشر عقد التوكن (ProjectToken)
  // نمرر ZeroAddress للـ vestingContract حالياً لأنه لم ينشر بعد
  const ProjectToken = await ethers.getContractFactory("ProjectToken");
  const token = await ProjectToken.deploy(
    tokenName,
    tokenSymbol,
    timelock,
    recipients,
    amounts,
    ethers.ZeroAddress
  );
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  console.log(`✅ ProjectToken deployed to: ${tokenAddress}`);

  // 2. نشر عقد الـ Vesting
  const Vesting = await ethers.getContractFactory("Vesting");
  const vesting = await Vesting.deploy(
    tokenAddress,
    timelock,
    signers,
    threshold
  );
  await vesting.waitForDeployment();
  const vestingAddress = await vesting.getAddress();
  console.log(`✅ Vesting deployed to: ${vestingAddress}`);

  // 3. نشر عقد الـ Airdrop
  const Airdrop = await ethers.getContractFactory("Airdrop");
  const airdrop = await Airdrop.deploy(
    tokenAddress, 
    timelock
  );
  await airdrop.waitForDeployment();
  const airdropAddress = await airdrop.getAddress();
  console.log(`✅ Airdrop deployed to: ${airdropAddress}`);

  console.log("\n--- Deployment Summary ---");
  console.log(`Token Address:   ${tokenAddress}`);
  console.log(`Vesting Address: ${vestingAddress}`);
  console.log(`Airdrop Address: ${airdropAddress}`);
  console.log("---------------------------\n");
}

// تنفيذ السكربت ومعالجة الأخطاء
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
