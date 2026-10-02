package house

// petFeedItem is the common bait material spent on feeding a companion and
// handed over with a successful steal. It is part of the published material
// whitelist, so it can never drift away from the catalog.
const petFeedItem = "bait_pack"

func petIDValid(id string) bool {
	if id == "" || len(id) > 32 {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_') {
			return false
		}
	}
	return true
}

func trackValid(track string) bool {
	switch track {
	case "cook", "brine", "trader":
		return true
	}
	return false
}

func containsPet(list []string, id string) bool {
	for _, v := range list {
		if v == id {
			return true
		}
	}
	return false
}

func removePet(list []string, id string) []string {
	out := list[:0]
	for _, v := range list {
		if v != id {
			out = append(out, v)
		}
	}
	return out
}

func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}
