use keyring::{Entry, Error};
use sha2::{Digest, Sha256};

use crate::{ConnectionIdentity, Result};

const SERVICE: &str = "dev.postgresui.desktop";

fn account(identity: &ConnectionIdentity) -> Result<String> {
    let encoded = serde_json::to_vec(identity).map_err(|error| error.to_string())?;
    Ok(format!("connection-{:x}", Sha256::digest(encoded)))
}

fn entry(identity: &ConnectionIdentity) -> Result<Entry> {
    Entry::new(SERVICE, &account(identity)?)
        .map_err(|_| "Could not access the OS credential store. Unlock or enable your system keyring and retry.".into())
}

fn read(entry: &Entry) -> Result<Option<String>> {
    match entry.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not read the saved password. Unlock or enable your system keyring and retry.".into()),
    }
}

fn write(entry: &Entry, password: &str) -> Result<()> {
    entry.set_password(password)
        .map_err(|_| "Could not save the password securely. Unlock or enable your system keyring and retry.".into())
}

fn delete(entry: &Entry) -> Result<()> {
    match entry.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(_) => Err("Could not remove the saved password. Unlock or enable your system keyring and retry.".into()),
    }
}

pub async fn load(identity: ConnectionIdentity) -> Result<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || read(&entry(&identity)?))
        .await.map_err(|_| "Credential store task failed")?
}

pub async fn save(identity: ConnectionIdentity, password: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || write(&entry(&identity)?, &password))
        .await.map_err(|_| "Credential store task failed")?
}

pub async fn remove(identity: ConnectionIdentity) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || delete(&entry(&identity)?))
        .await.map_err(|_| "Credential store task failed")?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mock_entry() -> Entry {
        Entry::new_with_credential(Box::new(keyring::mock::MockCredential::default()))
    }

    #[test]
    fn passwords_can_be_saved_restored_updated_and_removed() {
        let entry = mock_entry();
        assert_eq!(read(&entry).unwrap(), None);
        write(&entry, "  secret :/@  ").unwrap();
        assert_eq!(read(&entry).unwrap().as_deref(), Some("  secret :/@  "));
        write(&entry, "updated").unwrap();
        assert_eq!(read(&entry).unwrap().as_deref(), Some("updated"));
        write(&entry, "").unwrap();
        assert_eq!(read(&entry).unwrap().as_deref(), Some(""));
        delete(&entry).unwrap();
        assert_eq!(read(&entry).unwrap(), None);
        delete(&entry).unwrap();
    }

    #[test]
    fn credential_store_failures_are_not_treated_as_missing_passwords() {
        let entry = mock_entry();
        let credential = entry.get_credential().downcast_ref::<keyring::mock::MockCredential>().unwrap();
        credential.set_error(Error::Invalid("store".into(), "unavailable".into()));
        assert!(read(&entry).unwrap_err().contains("Could not read"));
        credential.set_error(Error::Invalid("store".into(), "unavailable".into()));
        assert!(write(&entry, "secret").unwrap_err().contains("Could not save"));
        credential.set_error(Error::Invalid("store".into(), "unavailable".into()));
        assert!(delete(&entry).unwrap_err().contains("Could not remove"));
    }

    #[test]
    fn credential_accounts_are_stable_and_isolate_servers_and_users() {
        let identity = ConnectionIdentity { host: "db.internal".into(), port: "5432".into(), username: Some("alice".into()) };
        let original = account(&identity).unwrap();
        assert_eq!(account(&identity).unwrap(), original);
        let other_user = ConnectionIdentity { username: Some("bob".into()), ..identity };
        assert_ne!(account(&other_user).unwrap(), original);
        let other_port = ConnectionIdentity { port: "6432".into(), username: Some("alice".into()), ..other_user };
        assert_ne!(account(&other_port).unwrap(), original);
        let other_host = ConnectionIdentity { host: "other.internal".into(), port: "5432".into(), ..other_port };
        assert_ne!(account(&other_host).unwrap(), original);
    }

    #[test]
    #[ignore = "requires an unlocked OS credential store"]
    fn native_store_persists_across_entry_instances() {
        let account = format!("test-{}-{}", std::process::id(), rand::random::<u64>());
        let original = Entry::new(SERVICE, &account).unwrap();
        write(&original, "temporary-integration-test-password").unwrap();
        let restored = Entry::new(SERVICE, &account).unwrap();
        let password = read(&restored);
        delete(&original).unwrap();
        assert_eq!(password.unwrap().as_deref(), Some("temporary-integration-test-password"));
        assert_eq!(read(&restored).unwrap(), None);
    }
}
