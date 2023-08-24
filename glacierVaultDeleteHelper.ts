import { ACCESS_KEY_ID, SECRET_ACCESS_KEY } from './.env.json';

import type { Stream } from 'stream';
import {
  GlacierClient,
  ListVaultsCommand,
  ListJobsCommand,
  InitiateJobCommand,
  DescribeJobCommand,
  GetJobOutputCommand,
  DeleteArchiveCommand,
} from '@aws-sdk/client-glacier';
import cliProgress from 'cli-progress';
import { EC2Client, DescribeRegionsCommand } from '@aws-sdk/client-ec2';
import type { GlacierClient as GlacierClientType } from '@aws-sdk/client-glacier';
import type { Region } from '@aws-sdk/client-ec2';

import confirm from '@inquirer/confirm';
import select, { Separator } from '@inquirer/select';

const DEFAULT_REGION = 'us-east-1';
const DEFAULT_CHECK_INTERVAL = 3600000; // 每小時檢查一次
const MIN_CHECK_INTERVAL = 10000; // 最小檢查間隔 10 秒

const accessKeyId = ACCESS_KEY_ID;
const secretAccessKey = SECRET_ACCESS_KEY;

type ChoiceOptions<Value> = {
  name: string;
  value: Value;
  description: string;
};

const credentials = {
  accessKeyId,
  secretAccessKey,
};

const progressBar = new cliProgress.SingleBar(
  {
    stopOnComplete: true,
    clearOnComplete: true,
    format: '{bar} {percentage}% ({value}/{total})',
  },
  cliProgress.Presets.shades_classic,
);

const awsEC2Client = new EC2Client({
  region: DEFAULT_REGION,
  credentials,
});

const terminateProcess = () => {
  console.info('Done!');
  process.exit();
};

const streamToString = (stream: Stream): Promise<string> => {
  return new Promise((resolve, reject) => {
    const chunks: any[] = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
};

async function getRegions() {
  try {
    const command = new DescribeRegionsCommand({});
    const response = await awsEC2Client.send(command);
    return response.Regions;
  } catch (err) {
    console.error('Error getting regions:', err);
  }
}

async function getGlacierVaults(glacierClient: GlacierClientType) {
  try {
    const command = new ListVaultsCommand({
      accountId: '-',
    });
    const response = await glacierClient.send(command);
    return response.VaultList;
  } catch (err) {
    console.error('Error getting vaults:', err);
  }
}

async function startGlacierVaultInventoryRetrieval(glacierClient: GlacierClientType, vaultName: string) {
  try {
    const params = {
      accountId: '-',
      vaultName,
      jobParameters: {
        Type: 'inventory-retrieval',
      },
    };
    const command = new InitiateJobCommand(params);
    const response = await glacierClient.send(command);
    console.log(`Job started for vault: ${vaultName}. Job ID: ${response.jobId}`);
    return response?.jobId || '';
  } catch (err) {
    console.error(`Failed to start job for vault: ${vaultName}`, err);
  }
}

async function getGlacierVaultInventoryRetrievalJobs(glacierClient: GlacierClientType, vaultName: string) {
  try {
    const command = new ListJobsCommand({ accountId: '-', vaultName });
    const response = await glacierClient.send(command);
    if (!response.JobList?.length) return null;
    return response.JobList.filter(({ Action }) => Action === 'InventoryRetrieval');
  } catch (err) {
    console.error('Error getting vaults:', err);
  }
}

type CheckJobStatusArgs = {
  glacierClient: GlacierClientType;
  vaultName: string;
  jobId: string;
  intervalMs?: number;
};

function checkGlacierVaultInventoryRetrievalJobStatus(args: CheckJobStatusArgs) {
  return new Promise<string>(async (resolve, reject) => {
    const { glacierClient, vaultName, jobId, intervalMs = DEFAULT_CHECK_INTERVAL } = args;
    try {
      const command = new DescribeJobCommand({
        accountId: '-',
        vaultName,
        jobId,
      });
      const response = await glacierClient.send(command);
      if (response.Completed) {
        resolve(jobId);
      } else {
        console.log('Vault Name:', vaultName);
        console.log('Job ID:', jobId);
        console.log('Job not yet completed. Checking again in 1 hour...');
        if (/^d+/.test((intervalMs as number) + '') && intervalMs >= MIN_CHECK_INTERVAL) {
          const timer = setTimeout(() => {
            clearTimeout(timer);
            checkGlacierVaultInventoryRetrievalJobStatus(args);
          }, intervalMs);
        }
      }
    } catch (err) {
      console.error('Error checking job status:', err);
      reject(err);
    }
  });
}

async function getVaultArchives(glacierClient: GlacierClientType, vaultName: string, jobId: string) {
  try {
    const command = new GetJobOutputCommand({
      accountId: '-',
      vaultName: vaultName,
      jobId: jobId,
    });
    const response = await glacierClient.send(command);
    const responseDataString = await streamToString(response.body as Stream);
    const responseData = JSON.parse(responseDataString);
    console.log(responseData.ArchiveList);
    console.log('length:', responseData.ArchiveList.length);
    return responseData.ArchiveList;
  } catch (err) {
    console.error('Failed to get job output', err);
  }
}

async function deleteVaultArchives(
  glacierClient: GlacierClientType,
  vaultName: string,
  archiveList: Record<string, unknown>[],
) {
  progressBar.start(archiveList.length, 0);
  for (const archive of archiveList) {
    const archiveId: string = archive.ArchiveId as string;
    try {
      const command = new DeleteArchiveCommand({
        accountId: '-',
        vaultName: vaultName,
        archiveId,
      });
      await glacierClient.send(command);
      progressBar.increment();
      console.log(`Successfully deleted archive: ${archiveId}`);
    } catch (err) {
      console.error(`Failed to delete archive: ${archiveId}`, err);
    }
  }
}

async function main() {
  const argIntervalMsIndex = process.argv.findIndex(item => item === '--check-interval-ms');
  const argIntervalMs = process.argv[argIntervalMsIndex + 1];
  console.log('welcome to using glacier vault delete helper.');
  const regions = await getRegions();
  if (!regions) return terminateProcess();

  const regionList = (regions as Region[]).map(({ RegionName, Endpoint }) => {
    return {
      name: RegionName as string,
      value: RegionName as string,
      description: Endpoint as string,
    };
  });

  const selectedRegion = await select({
    message: "what's your glacier vault region?",
    choices: regionList,
  });

  console.log(selectedRegion);

  const client = new GlacierClient({
    region: selectedRegion,
    credentials,
  });

  const vaults = await getGlacierVaults(client);

  if (!vaults) {
    console.log('no vaults found.');
    return terminateProcess();
  }

  const vaultList = (vaults as any[]).map(({ VaultName, VaultARN, SizeInBytes }) => {
    return {
      name: VaultName as string,
      value: VaultName as string,
      description: `VaultSizeInBytes: ${SizeInBytes * 1e-9} GB`,
    };
  });

  const selectedVault = await select({
    message: "what's your glacier vault?",
    choices: vaultList,
  });

  console.log(selectedVault);

  const jobs = await getGlacierVaultInventoryRetrievalJobs(client, selectedVault);
  let jobOptions: ChoiceOptions<string>[] = [];

  if (jobs) {
    jobOptions = jobs.map(({ JobId, Action, StatusCode, Completed, VaultARN, CreationDate }) => {
      return {
        name: `[${Completed ? `Completed` : StatusCode}]: ${JobId as string} (${Action})`,
        value: JobId as string,
        description: `CreationDate: ${CreationDate} - VaultARN: ${VaultARN}`,
      };
    });
  }

  const selectedJob = await select({
    message: "what's your glacier vault inventory retrieval job?",
    choices: [
      {
        name: `new`,
        value: 'createJob',
        description: `Create an new inventory retrieval job.`,
      },
      ...jobOptions,
    ],
  });

  console.log(selectedJob);

  let jobId = selectedJob;

  if (jobId === 'createJob') {
    jobId = (await startGlacierVaultInventoryRetrieval(client, selectedVault)) as string;
  }

  const autoDeleteArchiveAnswer = await confirm({
    message: 'would you want to continue to delete the vault archives automation? [yes/no]: ',
  });

  if (!autoDeleteArchiveAnswer) terminateProcess();

  const completeJobId = await checkGlacierVaultInventoryRetrievalJobStatus({
    glacierClient: client,
    vaultName: selectedVault,
    jobId,
    intervalMs: Number(argIntervalMs) as number,
  });

  const archivesList = await getVaultArchives(client, selectedVault, completeJobId);

  const deleteVaultsConfirm = await confirm({
    message: 'would you want to continue to delete the vault archives? [yes/no]: ',
  });

  if (!deleteVaultsConfirm) terminateProcess();
  await deleteVaultArchives(client, selectedVault, archivesList);
}

main().catch(err => {
  console.error('Error during the deletion process:', err);
});
