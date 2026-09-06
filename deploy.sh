#!/bin/bash
set -e

AWS_ACCOUNT="056798067837"
AWS_REGION="us-east-1"
REPO_NAME="yogue-aggregator-gateway"
ECR_URL="${AWS_ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com/${REPO_NAME}"
CLUSTER="default"
SERVICE="yogue-aggregator-gateway-1245"

echo "════════════════════════════════════════════════════"
echo "  Deploying to: ${SERVICE}"
echo "  Cluster:       ${CLUSTER}"
echo "  ECR repo:      ${REPO_NAME}"
echo "════════════════════════════════════════════════════"
read -p "Type the service name to confirm this is correct: " CONFIRM
if [ "$CONFIRM" != "$SERVICE" ]; then
  echo "❌ Confirmation didn't match — aborting. Nothing was built or deployed."
  exit 1
fi

echo "🔨 Building (no cache — avoids stale layers silently shipping old code)..."
docker build --no-cache --platform linux/amd64 -t ${REPO_NAME} .

echo "🔑 Login to ECR..."
aws ecr get-login-password --region ${AWS_REGION} | \
  docker login --username AWS --password-stdin ${AWS_ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com

echo "🏷️  Tagging..."
docker tag ${REPO_NAME}:latest ${ECR_URL}:latest

echo "📤 Pushing..."
docker push ${ECR_URL}:latest

echo "🚀 Triggering ECS deployment..."
aws ecs update-service \
  --cluster ${CLUSTER} \
  --service ${SERVICE} \
  --force-new-deployment \
  --region ${AWS_REGION} \
  --no-cli-pager > /dev/null

echo "⏳ Waiting for the new task to become healthy and steady (this can take a couple minutes)..."
aws ecs wait services-stable \
  --cluster ${CLUSTER} \
  --services ${SERVICE} \
  --region ${AWS_REGION}

echo "✅ Done! Deployment stable."
