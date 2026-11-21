import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import sync_powerbi_relational as spr


class TestOrHistoryStatus(unittest.TestCase):
    def test_count_or_inpatients_does_not_count_outpatients_with_mrn_as_matched(self):
        cases = [
            {"patientName": "منار عصام الدين محمود احمد", "mrn": "272716", "orRoom": "OR - 1", "vt": "HC", "column3": "Out"},
            {"patientName": "ايمان محمد", "mrn": "266693", "orRoom": "OR - 3", "vt": "DC", "column3": "Out"},
            {"patientName": "ياسين عبدالعزيز", "mrn": "275486", "orRoom": "OR - 7", "vt": "DC", "column3": "In"},
            {"patientName": "مريض منوم", "mrn": "999001", "orRoom": "OR - 2", "vt": "HC", "column3": "Out"},
        ]

        # Without active occupancy MRNs: only explicit column3 == IN counts as inpatient
        self.assertEqual(spr.count_or_inpatients(cases), 1)

        # With active occupancy MRNs: matches active inpatient MRNs OR explicit column3 == IN
        self.assertEqual(spr.count_or_inpatients(cases, active_mrns={"999001"}), 2)


if __name__ == "__main__":
    unittest.main()
