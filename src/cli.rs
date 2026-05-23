use std::path::PathBuf;

use clap::Parser;

#[derive(Debug, Parser)]
#[command(author, version, about)]
pub struct Cli {
    /// Path to the YAML configuration file.
    #[arg(short, long, default_value = "cdirect.yaml")]
    pub config: PathBuf,

    /// List available local audio and video inputs, then exit.
    #[arg(long)]
    pub list_inputs: bool,

    /// Check S3 credentials and bucket access, then exit.
    #[arg(long)]
    pub check_s3: bool,
}
