#!/bin/bash
set -e

AWS_ACCOUNT="056798067837"
AWS_REGION="us-east-1"
REPO_NAME="yogue-aggregator-gateway"
ECR_URL="${AWS_ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com/${REPO_NAME}"

echo "🔨 Building..."
docker build --platform linux/amd64 -t ${REPO_NAME} .

echo "🔑 Login to ECR..."
aws ecr get-login-password --region ${AWS_REGION} | \
  docker login --username AWS --password-stdin ${AWS_ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com

echo "🏷️  Tagging..."
docker tag ${REPO_NAME}:latest ${ECR_URL}:latest

echo "📤 Pushing..."
docker push ${ECR_URL}:latest

echo "🚀 Triggering ECS deployment..."
aws ecs update-service \
  --cluster default \
  --service yogue-aggregator-gateway-service-p5k9qaak \
  --force-new-deployment \
  --region ${AWS_REGION} \
  --no-cli-pager > /dev/null

echo "✅ Done! Watch deployment in ECS console."
# ./deploy.sh
