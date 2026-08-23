use std::{env, error::Error, fs, path::Path};

use base64::Engine;
use minisign_verify::{PublicKey, Signature};

fn decode_base64_text(value: &str) -> Result<String, Box<dyn Error>> {
    let decoded = base64::engine::general_purpose::STANDARD.decode(value.trim())?;
    Ok(std::str::from_utf8(&decoded)?.to_owned())
}

fn verify(
    public_key: &PublicKey,
    asset: &Path,
    signature_path: &Path,
) -> Result<(), Box<dyn Error>> {
    let bytes = fs::read(asset)?;
    let encoded_signature = fs::read_to_string(signature_path)?;
    let decoded_signature = decode_base64_text(&encoded_signature)?;
    let signature = Signature::decode(&decoded_signature)?;
    // Match tauri-plugin-updater's verification policy, including trusted comments.
    public_key.verify(&bytes, &signature, true)?;
    Ok(())
}

fn run() -> Result<(), Box<dyn Error>> {
    let mut args = env::args_os().skip(1);
    let encoded_public_key = args.next().ok_or("missing updater public key")?;
    let encoded_public_key = encoded_public_key
        .to_str()
        .ok_or("updater public key is not UTF-8")?;
    let decoded_public_key = decode_base64_text(encoded_public_key)?;
    let public_key = PublicKey::decode(&decoded_public_key)?;

    let remaining: Vec<_> = args.collect();
    if remaining.is_empty() || remaining.len() % 2 != 0 {
        return Err("expected one or more asset/signature path pairs".into());
    }
    for pair in remaining.chunks_exact(2) {
        verify(&public_key, Path::new(&pair[0]), Path::new(&pair[1]))?;
    }
    println!(
        "Verified {} updater artifact signature(s).",
        remaining.len() / 2
    );
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Updater artifact signature verification failed: {error}");
        std::process::exit(1);
    }
}
