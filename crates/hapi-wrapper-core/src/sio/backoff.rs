use std::time::Duration;
use uuid::Uuid;

#[derive(Default)]
pub(super) struct Backoff {
    attempt: u32,
}

impl Backoff {
    pub fn next(&mut self) -> Duration {
        let bits = Uuid::new_v4().as_u128() as u32;
        self.sample(f64::from(bits) / (f64::from(u32::MAX) + 1.0))
    }
    fn sample(&mut self, r: f64) -> Duration {
        let base = 1000u32 << self.attempt.min(4);
        self.attempt = self.attempt.saturating_add(1);
        let deviation = (r * 0.5 * f64::from(base)) as u32;
        let ms = if (r * 10.0) as u32 & 1 == 0 {
            base - deviation
        } else {
            base + deviation
        };
        Duration::from_millis(ms.min(5000).into())
    }
    pub fn reset(&mut self) {
        self.attempt = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    proptest! {
        #[test]
        fn matches_backo2(attempt in 0u32..64, r in 0.0f64..1.0) {
            let mut b=Backoff{attempt};
            let base=1000.0*2f64.powi(attempt as i32);
            let delta=(r*0.5*base).floor();
            let signed=if ((r*10.0).floor() as u64).is_multiple_of(2) {-delta} else {delta};
            prop_assert_eq!(b.sample(r).as_millis(),(base+signed).min(5000.0) as u128);
            b.reset(); prop_assert_eq!(b.sample(0.0).as_millis(),1000);
        }
    }
}
