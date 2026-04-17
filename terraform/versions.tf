terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Uncomment and configure for remote state in production
  # backend "s3" {
  #   bucket         = "your-terraform-state-bucket"
  #   key            = "quorum/terraform.tfstate"
  #   region         = "ap-southeast-2"
  #   dynamodb_table = "terraform-state-lock"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      ManagedBy   = "terraform"
      Application = "quorum"
      Environment = var.environment
    }
  }
}
