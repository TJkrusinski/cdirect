use std::path::Path;

use clap::Parser;

use cdirect::cli::Cli;
use cdirect::config::AppConfig;
use cdirect::{config, devices, pipeline, s3_publish};

#[tokio::main]
async fn main() -> Result<(), MainError> {
    load_dotenv()?;
    let cli = Cli::parse();

    if cli.list_inputs {
        let devices = devices::list_inputs();
        devices::print_device_list(&devices);
        return Ok(());
    }

    let config = AppConfig::from_path(&cli.config)?;

    if cli.check_s3 {
        let publisher = s3_publish::S3Publisher::from_config(&config.s3).await;
        publisher.check_bucket_access().await?;
        println!(
            "s3 access ok for bucket '{}' and prefix '{}'",
            config.s3.bucket, config.s3.prefix
        );
        return Ok(());
    }

    pipeline::run(config).await?;

    Ok(())
}

fn load_dotenv() -> Result<(), MainError> {
    let env_path = Path::new(".env");

    if env_path.exists() {
        dotenvy::from_path_override(env_path)?;
    }

    Ok(())
}

#[derive(Debug, thiserror::Error)]
enum MainError {
    #[error("failed to load .env: {0}")]
    Env(#[from] dotenvy::Error),
    #[error("{0}")]
    Config(#[from] config::ConfigError),
    #[error("{0}")]
    Pipeline(#[from] pipeline::PipelineError),
    #[error("{0}")]
    Publish(#[from] s3_publish::PublishError),
}
