# Salvo AWS foundation

This CloudFormation stack defines the family-pilot sandbox foundation. It does not create a running instance. The Salvo provisioner launches one isolated instance per active user from the launch template and stamps the user-specific ownership tag.

The launch template resolves its AMI from the promoted SSM parameter at deployment time. Instances use encrypted gp3 storage, IMDSv2, hibernation, SSM, no public IP, and a security group with no inbound rules. Outbound traffic is limited to HTTPS. The chosen private subnet therefore needs working HTTPS egress or VPC endpoints for SSM, the Salvo relay, and model access.

## Operator workflow

1. Copy `parameters.example.json` to the gitignored `parameters.json` and replace the VPC and subnet placeholders.
2. Publish a tested AMI ID to the configured SSM parameter.
3. Run `node salvo-aws.mjs validate`.
4. Run `node salvo-aws.mjs plan`. This is also the default command and creates a non-executed CloudFormation change set.
5. Inspect the change set in AWS. Apply only with `node salvo-aws.mjs apply --confirm`.

Destruction has a second guard: `node salvo-aws.mjs destroy --confirm --confirm-stack=salvo-family-pilot`. CloudFormation starts deletion but the operator must use `status` to verify the end state. Persistent user volumes have `DeleteOnTermination: false`; inventory and preserve or explicitly retire them through the separate user-data lifecycle before deleting the stack.

`BillingAlertEmail` enables an AWS Budget at 80% forecast and 100% actual spend. Leaving it blank omits the budget because AWS Budgets requires a notification subscriber. `InstanceType`, gp3 size/IOPS/throughput, log retention, and the monthly budget are explicit cost controls.

Hibernation also depends on the promoted AMI, instance family, root-volume capacity, and AWS regional support. Image promotion must reject an AMI that cannot hibernate.
