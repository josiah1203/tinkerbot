pub mod calc;

use crate::calc::add;

pub fn value() -> i32 {
    add(1, 1)
}

include!("generated.rs");
