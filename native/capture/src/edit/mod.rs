//! Cutting an existing recording (plan 085): the source's index (`source`), where each kept part starts and how each
//! join is made (`plan`), and the remux that writes the new file (`remux`). The source is only ever read.
pub mod plan;
pub mod remux;
pub mod source;
