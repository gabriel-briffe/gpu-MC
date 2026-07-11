use std::cell::RefCell;

use crate::idw::StoredWeightTable;

thread_local! {
    static INSTALLED_TABLE: RefCell<Option<StoredWeightTable>> = RefCell::new(None);
}

pub fn install_weight_table(table: StoredWeightTable) {
    INSTALLED_TABLE.with(|state| {
        *state.borrow_mut() = Some(table);
    });
}

pub fn clear_weight_table() {
    INSTALLED_TABLE.with(|state| {
        *state.borrow_mut() = None;
    });
}

pub fn with_installed_table<T>(f: impl FnOnce(&StoredWeightTable) -> Result<T, String>) -> Result<T, String> {
    INSTALLED_TABLE.with(|state| {
        let borrowed = state.borrow();
        let Some(table) = borrowed.as_ref() else {
            return Err("IDW weight table is not installed".into());
        };
        f(table)
    })
}
